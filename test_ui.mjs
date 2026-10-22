export default async function run(page, ui) {
  await page.locator('#u').fill('admin')
  await page.locator('#p').fill('test1234')
  await page.locator('#t').fill(process.env.TOTP_CODE)
  await page.locator('#loginBox button').click()
  await page.waitForFunction(() => document.getElementById('panel')?.style.display === 'block', { timeout: 15000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'd:/other/iNTERNET/SooshPanle/data/panel.png' })
  return 'saved'
}
