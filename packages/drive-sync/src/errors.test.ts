import { describe, expect, it } from 'vitest';
import { formatSignInError } from './errors.js';

describe('formatSignInError', () => {
  it.each([
    [{ code: 'popup_failed_to_open' }, 'Popup blocked. Allow popups for this site, then try again.'],
    [{ code: 'access_denied' }, 'Sign-in cancelled.'],
    [{ code: 'gis-load-failed' }, 'Could not reach Google. Check your connection or ad blocker.'],
    [{ message: 'boom' }, 'boom'],
    [null, 'Sign-in failed.'],
  ])('maps %j', (err, expected) => {
    expect(formatSignInError(err)).toBe(expected);
  });
});
