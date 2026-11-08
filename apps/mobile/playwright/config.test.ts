export default {
  testDir: '.',
  testMatch: '*.e2e.test.ts',
  workers: 1,
  timeout: 30000,
  use: { browserName: 'chromium', headless: true, launchOptions: process.env.CC_UI_CHROMIUM_EXECUTABLE ? {executablePath:process.env.CC_UI_CHROMIUM_EXECUTABLE} : {}, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } },
}
