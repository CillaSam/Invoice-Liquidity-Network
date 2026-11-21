import { StrKey } from '@stellar/stellar-sdk';

/**
 * Validates whether a string is a valid Stellar G-address (public account key).
 *
 * Uses Stellar SDK's StrKey to perform cryptographic validation, not just regex.
 * Valid G-addresses start with 'G' and are 56 characters long.
 *
 * @param s The string to validate
 * @returns true if valid G-address, false otherwise
 */
export function isValidGAddress(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) {
    return false;
  }

  try {
    return StrKey.isValidPublicKey(s);
  } catch {
    return false;
  }
}

/**
 * Validates whether a string is a valid Stellar contract ID.
 *
 * Uses Stellar SDK's StrKey to perform cryptographic validation.
 * Valid contract IDs start with 'C' and are 56 characters long.
 *
 * @param s The string to validate
 * @returns true if valid contract ID, false otherwise
 */
export function isValidContractId(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) {
    return false;
  }

  try {
    return StrKey.isValidContractId(s);
  } catch {
    return false;
  }
}

/**
 * Truncates a Stellar address for display purposes.
 *
 * Formats as: `FIRST_CHARS...LAST_CHARS`
 *
 * Example: `GABCD...XYZ` for a 56-character address with default 5-char truncation.
 *
 * @param s The address to truncate
 * @param chars Number of characters to show at start and end (default: 5)
 * @returns Truncated address string, or original if shorter than 2*chars
 *
 * @throws Error if chars is negative
 */
export function truncateAddress(s: string, chars: number = 5): string {
  if (typeof s !== 'string') {
    return '';
  }

  if (chars < 0) {
    throw new Error('truncateAddress: chars must be non-negative');
  }

  if (s.length <= chars * 2) {
    return s;
  }

  const start = s.substring(0, chars);
  const end = s.substring(s.length - chars);
  return `${start}...${end}`;
}

/**
 * Formats a Stellar address with full validation and checksums.
 *
 * Returns the address as-is if valid (Stellar SDK already validates checksums).
 * Throws if the address is invalid.
 *
 * @param s The address to format
 * @returns The validated address (StrKey validation ensures correct checksum)
 * @throws Error if the address is invalid (bad checksum, wrong type, etc.)
 */
export function formatAddress(s: string): string {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('formatAddress: address must be a non-empty string');
  }

  // StrKey functions will throw on invalid input
  if (StrKey.isValidPublicKey(s)) {
    return s;
  }

  if (StrKey.isValidContractId(s)) {
    return s;
  }

  // Additional Stellar key types that might be valid in some contexts
  if (StrKey.isValidMuxedAccount(s)) {
    return s;
  }

  throw new Error(
    `formatAddress: invalid Stellar address format for "${s.substring(0, 20)}${s.length > 20 ? '...' : ''}"`,
  );
}
