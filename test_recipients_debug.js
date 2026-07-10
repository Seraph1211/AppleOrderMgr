const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  console.log('Navigating to http://localhost:5173/recipients...');
  await page.goto('http://localhost:5173/recipients', { 
    waitUntil: 'networkidle0',
    timeout: 30000 
  });
  
  await sleep(3000);
  
  // Debug Test 1: Check button state and React state
  console.log('\n=== DEBUG: 生成联系方式 button ===');
  
  const buttonInfo = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(btn => btn.textContent.includes('生成联系方式'));
    
    if (btn) {
      return {
        found: true,
        text: btn.textContent,
        disabled: btn.disabled,
        classes: btn.className
      };
    }
    return { found: false };
  });
  
  console.log('Button info:', buttonInfo);
  
  // Click and check what happens
  console.log('\nClicking button and checking DOM changes...');
  
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(btn => btn.textContent.includes('生成联系方式'));
    if (btn) btn.click();
  });
  
  await sleep(2000);
  
  // Check for ANY modal-like elements
  const domCheck = await page.evaluate(() => {
    const results = {
      fixedElements: [],
      modals: [],
      overlays: [],
      zIndexElements: []
    };
    
    // Check for fixed positioned elements
    document.querySelectorAll('.fixed').forEach(el => {
      results.fixedElements.push({
        classes: el.className,
        visible: window.getComputedStyle(el).display !== 'none',
        text: el.textContent.substring(0, 100)
      });
    });
    
    // Check for elements with high z-index
    document.querySelectorAll('*').forEach(el => {
      const zIndex = parseInt(window.getComputedStyle(el).zIndex);
      if (zIndex >= 50) {
        results.zIndexElements.push({
          tag: el.tagName,
          classes: el.className,
          zIndex: zIndex,
          text: el.textContent.substring(0, 50)
        });
      }
    });
    
    return results;
  });
  
  console.log('\nDOM Check Results:');
  console.log('Fixed elements:', domCheck.fixedElements.length);
  domCheck.fixedElements.forEach((el, i) => {
    console.log(`  [${i}] ${el.classes} - visible: ${el.visible}`);
    if (el.text.includes('选择') || el.text.includes('取机人')) {
      console.log(`      Text: ${el.text}`);
    }
  });
  
  console.log('\nHigh z-index elements:', domCheck.zIndexElements.length);
  domCheck.zIndexElements.forEach((el, i) => {
    if (el.zIndex >= 50) {
      console.log(`  [${i}] ${el.tag}.${el.classes} - z-index: ${el.zIndex}`);
      if (el.text) console.log(`      Text: ${el.text}`);
    }
  });
  
  // Take screenshot
  await page.screenshot({ path: '/tmp/debug_after_click.png', fullPage: true });
  console.log('\n📸 Screenshot saved: /tmp/debug_after_click.png');
  
  await browser.close();
})();
