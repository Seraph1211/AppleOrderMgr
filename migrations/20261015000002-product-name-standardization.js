/** 当前业务名称规范化及原名审计；冻结规则，不依赖现行工具模块。 */
const logger = require('../src/utils/logger');
const CATALOG = require('../src/data/productNamingV20261015.json');

module.exports = {
  /** 建立保守映射及同事务原名审计，不自动回填历史业务。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `
            CREATE TABLE product_name_changes (
              id BIGSERIAL PRIMARY KEY,
              batch_id UUID NOT NULL,
              entity_type TEXT NOT NULL CHECK (entity_type IN ('orders','inventory_products')),
              entity_id TEXT NOT NULL,
              field_path TEXT NOT NULL,
              original_name TEXT NOT NULL,
              normalized_name TEXT NOT NULL,
              identity JSONB NOT NULL,
              rule_version TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              CHECK (original_name <> normalized_name)
            );
            CREATE INDEX product_name_changes_entity ON product_name_changes(entity_type,entity_id,id);
            CREATE INDEX product_name_changes_batch ON product_name_changes(batch_id,id);
            CREATE FUNCTION product_name_identity(product JSONB, target_field TEXT) RETURNS JSONB
            LANGUAGE SQL IMMUTABLE AS $function$
              SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb)
              FROM jsonb_each(product)
              WHERE key = ANY(ARRAY['name','title','productName','product_name','model','sku','skuCode','sku_code','partNumber','product_sku','productId','product_id','modelName','model_name','productModel','colorName','color_name','color','storageGb','storage_gb','capacity','storage','quantity'])
              AND key <> target_field;
            $function$;
            CREATE FUNCTION normalize_business_product_name(product JSONB) RETURNS TEXT
            LANGUAGE plpgsql IMMUTABLE AS $function$
            DECLARE
              original TEXT := COALESCE(product->>'name',product->>'title','');
              name_key TEXT;
              sku TEXT := upper(trim(normalize(COALESCE(product->>'sku',product->>'skuCode',product->>'partNumber',product->>'product_sku',CASE WHEN normalize(product->>'model',NFKC) ~* '^[A-Z0-9]{5,12}/[A-Z0-9]{1,3}$' THEN product->>'model' END,''),NFKC)));
              item JSONB;
              capacity TEXT;
              color TEXT;
              candidate TEXT;
              name_pattern TEXT;
              model_pattern TEXT;
              capacity_pattern TEXT;
              model_text TEXT;
            BEGIN
              name_key := lower(regexp_replace(normalize(original,NFKC),'\\s','','g'));
              FOR item IN SELECT value FROM jsonb_array_elements('${JSON.stringify(CATALOG)}'::jsonb) LOOP
                IF normalize(product->>'model',NFKC) ~* '^[A-Z0-9]{5,12}/[A-Z0-9]{1,3}$' AND upper(trim(normalize(product->>'model',NFKC))) <> item->>'sku' THEN CONTINUE; END IF;
                IF sku <> '' AND sku <> item->>'sku' THEN CONTINUE; END IF;
                IF EXISTS (SELECT 1 FROM jsonb_each_text(product) p WHERE p.key IN ('sku','skuCode','partNumber','product_sku') AND p.value <> '' AND upper(trim(normalize(p.value,NFKC))) <> item->>'sku') THEN CONTINUE; END IF;
                model_text := lower(regexp_replace(COALESCE(product->>'modelName',product->>'model_name',product->>'productModel',CASE WHEN normalize(product->>'model',NFKC) !~* '^[A-Z0-9]{5,12}/[A-Z0-9]{1,3}$' THEN product->>'model' END,item->>'modelName'),'\\s','','g'));
                IF regexp_replace(model_text,'^iphone','') NOT IN (regexp_replace(lower(replace(item->>'modelName',' ','')),'^iphone',''),regexp_replace(name_key,'^iphone','')) THEN CONTINUE; END IF;
                IF EXISTS (SELECT 1 FROM jsonb_each_text(product) p WHERE p.key IN ('modelName','model_name','productModel','model') AND p.value <> '' AND normalize(p.value,NFKC) !~* '^[A-Z0-9]{5,12}/[A-Z0-9]{1,3}$' AND regexp_replace(lower(regexp_replace(normalize(p.value,NFKC),'\\s','','g')),'^iphone','') NOT IN (regexp_replace(lower(replace(item->>'modelName',' ','')),'^iphone',''),regexp_replace(name_key,'^iphone',''))) THEN CONTINUE; END IF;
                FOREACH capacity IN ARRAY ARRAY(SELECT jsonb_array_elements_text(item->'capacityAliases')) LOOP
                  FOREACH color IN ARRAY ARRAY(SELECT jsonb_array_elements_text(item->'colorAliases')) LOOP
                    model_pattern := replace(item->>'modelName',' ','\\s*');
                    capacity_pattern := substring(capacity from '^[0-9]+')||'\\s*'||substring(capacity from '[A-Z]+$');
                    name_pattern := '^'||model_pattern||'\\s+('||color||'\\s*'||capacity_pattern||'|'||capacity_pattern||'\\s*'||color||')$';
                    IF regexp_replace(normalize(original,NFKC),'^\\s+|\\s+$','','g') !~* name_pattern THEN CONTINUE; END IF;
                    candidate := lower(replace((item->>'modelName')||color||capacity,' ',''));
                    IF name_key NOT IN (candidate,lower(replace((item->>'modelName')||capacity||color,' ',''))) THEN CONTINUE; END IF;
                    IF EXISTS (SELECT 1 FROM jsonb_each_text(product) p WHERE p.key IN ('color','colorName','color_name') AND p.value <> '' AND NOT (regexp_replace(normalize(p.value,NFKC),'^\\s+|\\s+$','','g') IN (SELECT jsonb_array_elements_text(item->'colorAliases')))) THEN CONTINUE; END IF;
                    IF EXISTS (SELECT 1 FROM jsonb_each_text(product) p WHERE p.key IN ('storageGb','storage_gb','capacity','storage') AND p.value <> '' AND NOT ((normalize(p.value,NFKC) ~* '^\\s*(128|256|512|1024|2048|1|2)\\s*(GB|TB|G|T)\\s*$' AND upper(regexp_replace(normalize(p.value,NFKC),'\\s','','g')) IN (SELECT upper(jsonb_array_elements_text(item->'capacityAliases')))) OR trim(normalize(p.value,NFKC))=item->>'storageGb')) THEN CONTINUE; END IF;
                    IF EXISTS (SELECT 1 FROM jsonb_each_text(product) p WHERE p.key IN ('title','productName','product_name') AND p.value <> '' AND normalize_business_product_name((product-'title'-'productName'-'product_name')||jsonb_build_object('name',p.value)) <> item->>'name') THEN CONTINUE; END IF;
                    RETURN item->>'name';
                  END LOOP;
                END LOOP;
              END LOOP;
              RETURN original;
            END;
            $function$;
            CREATE FUNCTION audit_business_product_names() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
            DECLARE
              item JSONB;
              normalized TEXT;
              original TEXT;
              item_index INTEGER := 0;
              result JSONB := '[]'::jsonb;
              batch UUID := COALESCE(NULLIF(current_setting('apple.product_name_batch',true),'')::uuid,gen_random_uuid());
              source TEXT := COALESCE(NULLIF(current_setting('apple.product_name_source',true),''),'business_write');
            BEGIN
              IF TG_TABLE_NAME='orders' THEN
                IF TG_OP='UPDATE' AND NEW.products IS NOT DISTINCT FROM OLD.products AND source<>'historical_batch' THEN RETURN NEW; END IF;
                IF jsonb_typeof(NEW.products)<>'array' THEN RETURN NEW; END IF;
                FOR item IN SELECT value FROM jsonb_array_elements(NEW.products) LOOP
                  original := item->>'name';
                  normalized := normalize_business_product_name(item);
                  IF original IS NOT NULL AND normalized <> original THEN
                    INSERT INTO product_name_changes(batch_id,entity_type,entity_id,field_path,original_name,normalized_name,identity,rule_version,source)
                    VALUES(batch,TG_TABLE_NAME,NEW.id::text,'products.'||item_index||'.name',original,normalized,product_name_identity(item,'name'),'20261015-v1',source);
                    item := jsonb_set(item,'{name}',to_jsonb(normalized));
                  END IF;
                  result := result||jsonb_build_array(item);
                  item_index := item_index+1;
                END LOOP;
                NEW.products := result;
              ELSE
                IF TG_OP='UPDATE' AND NEW.body->'title' IS NOT DISTINCT FROM OLD.body->'title' AND source<>'historical_batch' THEN RETURN NEW; END IF;
                original := NEW.body->>'title';
                normalized := normalize_business_product_name(NEW.body);
                IF original IS NOT NULL AND normalized <> original THEN
                  INSERT INTO product_name_changes(batch_id,entity_type,entity_id,field_path,original_name,normalized_name,identity,rule_version,source)
                  VALUES(batch,TG_TABLE_NAME,NEW.id::text,'body.title',original,normalized,product_name_identity(NEW.body,'title'),'20261015-v1',source);
                  NEW.body := jsonb_set(NEW.body,'{title}',to_jsonb(normalized));
                END IF;
              END IF;
              RETURN NEW;
            END;
            $function$;
            CREATE TRIGGER orders_product_name_audit BEFORE INSERT OR UPDATE OF products ON orders FOR EACH ROW EXECUTE FUNCTION audit_business_product_names();
            CREATE TRIGGER inventory_product_name_audit BEFORE INSERT OR UPDATE OF body ON inventory_products FOR EACH ROW EXECUTE FUNCTION audit_business_product_names();
          `,
            { transaction }
          );
        } catch (error) {
          logger.debug('商品名称迁移事务未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('商品名称迁移未完成', { code: error.code || error.name });
      throw error;
    }
  },
  /** 有审计事实则拒绝破坏性回退。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            'LOCK TABLE orders, inventory_products IN SHARE ROW EXCLUSIVE MODE; LOCK TABLE product_name_changes IN ACCESS EXCLUSIVE MODE',
            { transaction }
          );
          const [rows] = await queryInterface.sequelize.query(
            'SELECT 1 FROM product_name_changes LIMIT 1',
            { transaction }
          );
          if (rows.length) throw new Error('已有商品原名审计事实，拒绝删除；请使用应用回退');
          await queryInterface.sequelize.query(
            'DROP TRIGGER orders_product_name_audit ON orders; DROP TRIGGER inventory_product_name_audit ON inventory_products; DROP FUNCTION audit_business_product_names(); DROP FUNCTION normalize_business_product_name(JSONB); DROP FUNCTION product_name_identity(JSONB,TEXT); DROP TABLE product_name_changes',
            { transaction }
          );
        } catch (error) {
          logger.debug('商品名称回退事务未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('商品名称回退未完成', { code: error.code || error.name });
      throw error;
    }
  },
};
