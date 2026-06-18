export function isTestMode(): boolean {
  return process.env.TEST_MODE === 'true';
}

export const navjotPhone = '+1 519-505-5832';
export const navjotEmail = 'chahalnavi30@yahoo.com';

// Lofty returns phones as raw digits (e.g. "5195055832"), not the
// formatted/country-coded form navjotPhone is written in, so a plain
// string match would never hit — compare by the last 10 digits instead.
function normalizePhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isNavjotPhone(phone: string | null | undefined): boolean {
  return normalizePhone(phone) === normalizePhone(navjotPhone);
}
