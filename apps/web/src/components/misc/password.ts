/** Shared password policy for reset and change-password forms (mirrors the API's checks). */
export const PASSWORD_RULE = 'At least 10 characters, including letters and numbers.';

export function passwordProblem(pw: string): string | undefined {
  if (!pw) return 'Enter a new password.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Include both letters and numbers.';
  return undefined;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
