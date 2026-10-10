/** 在真实控件上选择；手机走按钮面板，桌面走原生select。 */
async function chooseSelect(control, value) {
  try {
    const button = await control.evaluate(node => node.tagName === 'BUTTON');
    if (!button) return await control.selectOption(value);
    const label = await control.evaluate(
      (node, selectedValue) =>
        [...node.nextElementSibling.options].find(option => option.value === selectedValue)?.text,
      value
    );
    if (!label) throw new Error(`选项不存在：${value}`);
    await control.click();
    await control
      .page()
      .locator('dialog.mobile-picker-dialog')
      .getByRole('option', { name: label, exact: true })
      .click();
  } catch (error) {
    throw new Error(`下拉选择失败：${error.message}`, { cause: error });
  }
}

/** 读取原生表单值，兼容手机可见按钮。 */
async function selectValue(control) {
  try {
    return await control.evaluate(
      node => (node.tagName === 'BUTTON' ? node.nextElementSibling : node).value
    );
  } catch (error) {
    throw new Error(`下拉值读取失败：${error.message}`, { cause: error });
  }
}
module.exports = { chooseSelect, selectValue };
