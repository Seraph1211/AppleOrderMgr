const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Track native alert/confirm calls
  await page.evaluateOnNewDocument(() => {
    window._nativeAlertCalled = false;
    window._nativeConfirmCalled = false;
    
    const originalAlert = window.alert;
    const originalConfirm = window.confirm;
    
    window.alert = function(...args) {
      window._nativeAlertCalled = true;
      console.error('❌ NATIVE ALERT CALLED:', args);
      return originalAlert.apply(this, args);
    };
    
    window.confirm = function(...args) {
      window._nativeConfirmCalled = true;
      console.error('❌ NATIVE CONFIRM CALLED:', args);
      return originalConfirm.apply(this, args);
    };
  });
  
  console.log('Navigating to http://localhost:5173/recipients...');
  await page.goto('http://localhost:5173/recipients', { 
    waitUntil: 'networkidle0',
    timeout: 30000 
  });
  
  await sleep(3000);
  
  console.log('\n📸 Taking initial page snapshot...');
  await page.screenshot({ path: '/tmp/recipients_initial.png', fullPage: true });
  console.log('✅ Saved: /tmp/recipients_initial.png');
  
  // Helper function to check for modals - updated selectors
  const checkForModal = async (testName) => {
    await sleep(2000);
    
    const modalInfo = await page.evaluate(() => {
      // Look for modal by class patterns used in the project
      // AlertModal and ConfirmModal use: fixed inset-0 bg-black bg-opacity-50
      const overlay = document.querySelector('.fixed.inset-0.bg-black.bg-opacity-50') ||
                     document.querySelector('[class*="fixed"][class*="inset-0"][class*="bg-black"]') ||
                     document.querySelector('[role="dialog"]');
      
      if (overlay) {
        const style = window.getComputedStyle(overlay);
        const isVisible = style.display !== 'none' && style.opacity !== '0';
        
        // Get modal content
        const modalContent = overlay.querySelector('.bg-white.rounded-xl') || overlay.querySelector('.bg-white');
        if (!modalContent) {
          return { found: false };
        }
        
        const title = modalContent.querySelector('h3')?.textContent || '';
        const message = modalContent.querySelector('p')?.textContent || '';
        const buttons = Array.from(modalContent.querySelectorAll('button')).map(btn => btn.textContent.trim());
        
        // Check for blue theme classes
        const hasBlueTheme = modalContent.innerHTML.includes('btn-primary') ||
                            modalContent.innerHTML.includes('text-primary') ||
                            modalContent.innerHTML.includes('bg-primary');
        
        return {
          found: true,
          visible: isVisible,
          title: title.trim(),
          message: message.trim(),
          buttons,
          hasBlueTheme
        };
      }
      return { found: false };
    });
    
    if (modalInfo.found) {
      console.log('✅ Custom modal detected!');
      console.log('   Visible:', modalInfo.visible);
      console.log('   Title:', modalInfo.title);
      console.log('   Message:', modalInfo.message);
      console.log('   Buttons:', modalInfo.buttons);
      console.log('   Has blue theme:', modalInfo.hasBlueTheme);
      
      // Verify expected message
      if (testName === 'generate_contact' && modalInfo.message.includes('请先选择需要生成联系方式的取机人记录')) {
        console.log('   ✅ Message matches expected content');
      } else if (testName === 'generate_address' && modalInfo.message.includes('请先选择需要生成地址的取机人记录')) {
        console.log('   ✅ Message matches expected content');
      } else if (testName === 'export_confirm' && modalInfo.message.includes('未选择任何取机人记录')) {
        console.log('   ✅ Message matches expected content');
      }
      
      return true;
    } else {
      console.log('❌ FAIL: No custom modal found');
      return false;
    }
  };
  
  // Test 1: Click "生成联系方式" without selection
  console.log('\n\n=== TEST 1: 生成联系方式 (no selection) ===');
  
  const contactButtonExists = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(btn => btn.textContent.includes('生成联系方式'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  
  if (!contactButtonExists) {
    console.log('❌ ERROR: 生成联系方式 button not found');
  } else {
    console.log('✅ Button found and clicked');
    
    const alertCalled = await page.evaluate(() => window._nativeAlertCalled);
    if (alertCalled) {
      console.log('❌ FAIL: Native alert was called!');
    } else {
      console.log('✅ PASS: No native alert called');
    }
    
    const modalFound = await checkForModal('generate_contact');
    if (modalFound) {
      await page.screenshot({ path: '/tmp/modal_contact_no_selection.png', fullPage: true });
      console.log('📸 Saved: /tmp/modal_contact_no_selection.png');
      
      // Close modal by clicking X or 确定 button
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const closeBtn = buttons.find(btn => btn.textContent.includes('确定'));
        if (closeBtn) closeBtn.click();
      });
      await sleep(1000);
    }
  }
  
  // Test 2: Click "生成地址" without selection
  console.log('\n\n=== TEST 2: 生成地址 (no selection) ===');
  
  const addressButtonExists = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(btn => btn.textContent.includes('生成地址'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  
  if (!addressButtonExists) {
    console.log('❌ ERROR: 生成地址 button not found');
  } else {
    console.log('✅ Button found and clicked');
    
    const alertCalled = await page.evaluate(() => window._nativeAlertCalled);
    if (alertCalled) {
      console.log('❌ FAIL: Native alert was called!');
    } else {
      console.log('✅ PASS: No native alert called');
    }
    
    const modalFound = await checkForModal('generate_address');
    if (modalFound) {
      await page.screenshot({ path: '/tmp/modal_address_no_selection.png', fullPage: true });
      console.log('📸 Saved: /tmp/modal_address_no_selection.png');
      
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const closeBtn = buttons.find(btn => btn.textContent.includes('确定'));
        if (closeBtn) closeBtn.click();
      });
      await sleep(1000);
    }
  }
  
  // Test 3: Click "导出Excel" without selection
  console.log('\n\n=== TEST 3: 导出Excel (no selection) ===');
  
  const exportButtonExists = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(btn => btn.textContent.includes('导出Excel'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  
  if (!exportButtonExists) {
    console.log('❌ ERROR: 导出Excel button not found');
  } else {
    console.log('✅ Button found and clicked');
    
    const confirmCalled = await page.evaluate(() => window._nativeConfirmCalled);
    if (confirmCalled) {
      console.log('❌ FAIL: Native confirm was called!');
    } else {
      console.log('✅ PASS: No native confirm called');
    }
    
    const modalFound = await checkForModal('export_confirm');
    if (modalFound) {
      await page.screenshot({ path: '/tmp/modal_export_no_selection.png', fullPage: true });
      console.log('📸 Saved: /tmp/modal_export_no_selection.png');
      
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const cancelBtn = buttons.find(btn => btn.textContent.includes('取消'));
        if (cancelBtn) cancelBtn.click();
      });
      await sleep(1000);
    }
  }
  
  // Final summary
  console.log('\n\n=== FINAL SUMMARY ===');
  const finalCheck = await page.evaluate(() => ({
    nativeAlert: window._nativeAlertCalled,
    nativeConfirm: window._nativeConfirmCalled
  }));
  
  console.log('\n🎯 TEST RESULTS:');
  console.log('Native alert called:', finalCheck.nativeAlert ? '❌ FAIL' : '✅ PASS');
  console.log('Native confirm called:', finalCheck.nativeConfirm ? '❌ FAIL' : '✅ PASS');
  console.log('\n📋 All modals should:');
  console.log('  ✓ Use custom styled modals (not browser native)');
  console.log('  ✓ Match project blue theme');
  console.log('  ✓ Have proper close buttons');
  console.log('  ✓ Display expected messages');
  
  await browser.close();
  console.log('\n✅ Test completed. Screenshots saved to /tmp/');
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
