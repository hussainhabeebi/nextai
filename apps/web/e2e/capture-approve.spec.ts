import { expect, test } from '@playwright/test';

const PHONE = process.env.E2E_PHONE ?? '+919999999999'; // seeded demo owner

const bill = {
  docType: 'purchase_invoice',
  supplierName: 'E2E Stationers',
  supplierTaxId: null,
  invoiceNo: `E2E-${Date.now()}`,
  date: new Date().toISOString().slice(0, 10),
  currency: 'INR',
  lines: [{ description: 'Printer paper', qty: 4, rate: 300, amount: 1200 }],
  subtotal: 1200,
  tax: { cgst: 0, sgst: 0, igst: 0, vat: 0 },
  total: 1200,
  paymentMode: 'credit',
  confidence: 0.95,
};

test('login → capture → approve → posted', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('WhatsApp number').fill(PHONE);
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  // non-production API returns the dev code, which the page pre-fills
  await expect(page.getByLabel('6-digit code')).toHaveValue(/\d{6}/);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Capture' }).click();
  // The mock vision provider reads a JSON extraction from the uploaded bytes.
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JSON.stringify(bill)) });
  await page.getByRole('button', { name: /Upload 1/ }).click();
  await expect(page.getByRole('status')).toContainText(/Uploaded|Saved offline/);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals' }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('E2E Stationers').first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByText('E2E Stationers').first().click();
  await expect(page.getByText('₹1,200.00')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(async () => {
    await page.reload();
    await expect(page.getByText('posted', { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
});
