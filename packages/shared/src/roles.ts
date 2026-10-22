// Application roles checked by the BFF (Req 20) and used by the UI to show/hide actions.
export const ROLES = {
  READ: 'GuestSearch.Read',
  REVEAL: 'GuestSearch.RevealPII',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
