export default {
  testDir: '.',
  testMatch: '*.e2e.test.ts',
  workers: 1,
  timeout: 30000,
  use: { browserName: 'chromium', headless: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } },
}
