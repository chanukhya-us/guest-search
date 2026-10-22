// GuestDetailsDrawer: the modal side drawer showing a guest's full record and the reveal
// flow (task 12.7, design.md "GuestDetailsDrawer.tsx — RAC Modal/Dialog, focus trap,
// return focus"; Req 16, 14).
//
// Drawer type (per design.md): a MODAL side drawer built on React Aria Components'
// ModalOverlay + Modal + Dialog. RAC gives us, for free and correctly: aria-modal="true"
// (Req 16.3), a focus trap for as long as it is open (Req 16.3), Escape-to-close and
// return-of-focus to the control that opened it when it unmounts (Req 16.4). The dialog is
// labelled by the guest's name via the <Heading slot="title">. The slide-in uses a short
// transform/opacity transition that the global prefers-reduced-motion reset neutralises
// (theme.css), so no motion-specific code is needed here.
//
// Content (Req 16.2): every address, phone, email and membership from summary.guest — not
// just the BFF-selected primaries. The primary of each collection is marked with a TEXT
// "Primary" badge (not colour alone), identified by reference equality against
// pickPrimary(...) so the label matches the BFF's own selection (Req 13).
//
// Masking + reveal (Req 16.5, 14): phones and emails render MASKED exactly as they arrive
// in summary.guest. Nothing unmasked is shown until a reveal succeeds. The "Reveal contact
// details" button appears only when the colleague holds the REVEAL role AND the row has a
// revealToken (Req 14.15, 14.12); a read-only user never sees it and has no token. On
// click it calls revealGuest(revealToken); on success the unmasked phones/emails returned
// by the BFF replace the masked lists for this guest (stored in the in-memory reveal map,
// Req 14.12/14.13) and a polite "contact details revealed" status is announced. On
// REVEAL_EXPIRED an inline "Details expired. Please search again." message shows and the
// masked view stays (Req 14.14); the button is not offered again for that stale token. Any
// other error shows its catalog message inline. Unmasked values are never persisted: they
// live only in the reveal map (cleared on new search / Clear / sign-out) — closing the
// drawer keeps them for the still-visible row but writes nothing durable (Req 21.7/21.8).
import type {
  GuestAddress,
  GuestEmail,
  GuestMembership,
  GuestPhone,
  GuestSummary,
} from '@ihg-guest-search/shared';
import { pickPrimary } from '@ihg-guest-search/shared';
import { useCallback, useId, type ReactNode } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { EMPTY_INDICATOR, EMPTY_LABEL, guestDisplayName, orEmpty } from '../../lib/format.js';
import { REVEAL_EXPIRED_MESSAGE, useRevealAction, type RevealMap } from './useReveal.js';

export interface GuestDetailsDrawerProps {
  /** The selected guest, or null when the drawer is closed. */
  summary: GuestSummary | null;
  /** Whether the colleague holds GuestSearch.RevealPII (gates the reveal control, Req 14.15). */
  canReveal: boolean;
  /** The in-memory reveal store shared with the table (Req 14.12, 14.13). */
  reveal: RevealMap;
  /** Close the drawer; RAC returns focus to the opening control (Req 16.4). */
  onClose: () => void;
}

/**
 * The details drawer. Rendered unconditionally by the results panel; it is open exactly
 * when `summary` is non-null. ModalOverlay is controlled via `isOpen` / `onOpenChange` so
 * that pressing Escape, clicking the backdrop or activating Close all route through
 * `onClose` (Req 16.4), and RAC unmounts the modal and restores focus to the trigger.
 */
export function GuestDetailsDrawer({
  summary,
  canReveal,
  reveal,
  onClose,
}: GuestDetailsDrawerProps) {
  // React Aria conveys the modal barrier with aria-hidden on the rest of the page rather
  // than aria-modal, and filterDOMProps strips an aria-modal passed to <Dialog>. Req 16.3
  // asks for aria-modal="true" explicitly, so set it on the dialog node via a callback ref
  // once it mounts. This is additive to RAC's own correct modal semantics.
  const dialogRef = useCallback((node: HTMLElement | null) => {
    node?.setAttribute('aria-modal', 'true');
  }, []);

  return (
    <ModalOverlay
      isOpen={summary !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-30 flex justify-end bg-navy/40 data-[entering]:animate-[fade-in_150ms] "
    >
      <Modal className="h-full w-full max-w-md bg-surface shadow-panel outline-none data-[entering]:animate-[slide-in_150ms]">
        {/*
          aria-modal is set explicitly (Req 16.3): react-aria-components conveys the modal
          barrier with aria-hidden on the rest of the page rather than aria-modal, so we add
          it ourselves. The dialog is labelled by the guest-name <Heading slot="title">
          (RAC wires aria-labelledby automatically), so no static aria-label is needed.
        */}
        <Dialog ref={dialogRef} className="flex h-full flex-col outline-none">
          {summary !== null && (
            <DrawerContent
              summary={summary}
              canReveal={canReveal}
              reveal={reveal}
              onClose={onClose}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * The drawer body for a specific guest. Split out from the shell so React remounts it per
 * selected guest (new `summary` identity), resetting the reveal mutation's local error.
 */
function DrawerContent({
  summary,
  canReveal,
  reveal,
  onClose,
}: {
  summary: GuestSummary;
  canReveal: boolean;
  reveal: RevealMap;
  onClose: () => void;
}) {
  const titleId = useId();
  const { guest, revealToken } = summary;
  const name = guestDisplayName(guest);
  const revealed = reveal.get(guest.enterpriseId);

  // Shared reveal action (Req 14.7): swaps masked for unmasked in the in-memory map and
  // announces success. It owns the busy / expired / error states shown below.
  const action = useRevealAction(guest.enterpriseId, name, reveal);

  // The reveal affordance shows only with the role AND a token, and only while nothing has
  // been revealed yet for this guest (Req 14.12, 14.15). An expired token is not retried.
  const canOfferReveal =
    canReveal && typeof revealToken === 'string' && revealed === undefined && !action.expired;

  return (
    <>
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <Heading slot="title" id={titleId} className="text-xl font-semibold text-navy">
            {name}
          </Heading>
          <p className="mt-1 text-sm text-text-2">Enterprise ID: {guest.enterpriseId}</p>
        </div>
        <Button
          onPress={onClose}
          className="rounded-control border border-navy px-3 py-1 text-navy hover:bg-navy-wash"
        >
          <span aria-hidden="true">Close</span>
          <span className="sr-only">Close guest details</span>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4" aria-labelledby={titleId}>
        {/* Identity summary: score/band stated in text (Req 15.6, 24.5). */}
        <dl className="mb-6 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="font-semibold text-text-2">Match score</dt>
          <dd className="text-body">{formatScore(guest.score)}</dd>
          <dt className="font-semibold text-text-2">First name</dt>
          <dd className="text-body">{orEmpty(guest.firstName)}</dd>
          <dt className="font-semibold text-text-2">Last name</dt>
          <dd className="text-body">{orEmpty(guest.lastName)}</dd>
        </dl>

        {/* Reveal control + inline state (Req 14.12, 14.14, 14.15). */}
        {(canOfferReveal || action.pending || action.errorMessage || action.expired) && (
          <div className="mb-6">
            {canOfferReveal && (
              // Pending is conveyed by disabling the button and swapping its label text
              // ("Revealing…"), not RAC's `isPending`. `isPending` renders an extra hidden
              // `<div role="img">` progress indicator labelled by the button's content; our
              // content is an aria-hidden span, so that indicator ends up with an empty
              // accessible name and fails axe's role-img-alt (WCAG 1.1.1). Using isDisabled
              // keeps the same UX without the unlabelled image node.
              <Button
                isDisabled={action.pending}
                aria-label={`Reveal contact details for ${name}`}
                onPress={() => revealToken && action.run(revealToken)}
                className="inline-flex h-11 items-center rounded-control bg-primary px-5 text-base font-medium text-surface hover:bg-primary-hover data-[disabled]:opacity-70"
              >
                <span aria-hidden="true">
                  {action.pending ? 'Revealing…' : 'Reveal contact details'}
                </span>
              </Button>
            )}
            {action.expired && (
              <p
                role="alert"
                className="mt-2 flex items-start gap-2 text-error"
                data-testid="reveal-expired"
              >
                <span aria-hidden="true" className="font-semibold">
                  !
                </span>
                <span>{REVEAL_EXPIRED_MESSAGE}</span>
              </p>
            )}
            {action.errorMessage && (
              <p role="alert" className="mt-2 flex items-start gap-2 text-error">
                <span aria-hidden="true" className="font-semibold">
                  !
                </span>
                <span>{action.errorMessage}</span>
              </p>
            )}
          </div>
        )}

        <AddressSection addresses={guest.addresses} />
        <PhoneSection phones={guest.phones} revealedPhones={revealed?.phones} />
        <EmailSection emails={guest.emails} revealedEmails={revealed?.emails} />
        <MembershipSection memberships={guest.memberships} />
      </div>
    </>
  );
}

/** A labelled collection section with a consistent heading and empty fallback. */
function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-2">{title}</h3>
      {empty ? (
        <p className="text-body text-muted">{EMPTY_LABEL}</p>
      ) : (
        <ul className="space-y-3">{children}</ul>
      )}
    </section>
  );
}

/** A "Primary" text badge marking the primary item of a collection (Req 16.2, 24.5). */
function PrimaryBadge() {
  return (
    <span className="ml-2 rounded-chip bg-navy-wash px-2 py-0.5 text-xs font-semibold text-navy">
      Primary
    </span>
  );
}

function AddressSection({ addresses }: { addresses: readonly GuestAddress[] }) {
  const primary = pickPrimary(addresses);
  return (
    <Section title="Addresses" empty={addresses.length === 0}>
      {addresses.map((address, i) => (
        <li key={i} className="rounded-control border border-border p-3">
          <div className="flex items-start justify-between">
            <AddressLines address={address} />
            {address === primary && <PrimaryBadge />}
          </div>
        </li>
      ))}
    </Section>
  );
}

function AddressLines({ address }: { address: GuestAddress }) {
  const lines = [
    address.line1,
    address.line2,
    [address.city, address.stateOrRegion, address.postalCode].filter(Boolean).join(', '),
    address.country,
  ].filter((l): l is string => Boolean(l && l.length > 0));
  if (lines.length === 0) {
    return <span className="text-muted">{EMPTY_LABEL}</span>;
  }
  return (
    <span className="text-body">
      {lines.map((line, i) => (
        <span key={i} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

function PhoneSection({
  phones,
  revealedPhones,
}: {
  phones: readonly GuestPhone[];
  revealedPhones: readonly GuestPhone[] | undefined;
}) {
  // When revealed, show the unmasked phones returned by the BFF; otherwise the masked
  // collection from the result (Req 16.5). Primary is marked on the masked collection, by
  // reference against pickPrimary; the unmasked list carries its own profileDefault flags.
  const list = revealedPhones ?? phones;
  const primary = pickPrimary(list);
  return (
    <Section title="Phones" empty={list.length === 0}>
      {list.map((phone, i) => (
        <li key={i} className="flex items-center">
          <span className="text-body">{phone.number}</span>
          {phone.type && <span className="ml-2 text-sm text-text-2">({phone.type})</span>}
          {phone === primary && <PrimaryBadge />}
        </li>
      ))}
    </Section>
  );
}

function EmailSection({
  emails,
  revealedEmails,
}: {
  emails: readonly GuestEmail[];
  revealedEmails: readonly GuestEmail[] | undefined;
}) {
  const list = revealedEmails ?? emails;
  const primary = pickPrimary(list);
  return (
    <Section title="Emails" empty={list.length === 0}>
      {list.map((email, i) => (
        <li key={i} className="flex items-center">
          <span className="text-body">{email.address}</span>
          {email === primary && <PrimaryBadge />}
        </li>
      ))}
    </Section>
  );
}

function MembershipSection({ memberships }: { memberships: readonly GuestMembership[] }) {
  const primary = pickPrimary(memberships);
  return (
    <Section title="Memberships" empty={memberships.length === 0}>
      {memberships.map((membership, i) => (
        <li key={i} className="rounded-control border border-border p-3">
          <div className="flex items-start justify-between">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="font-semibold text-text-2">Member type</dt>
              <dd className="text-body">{orEmpty(membership.memberType)}</dd>
              <dt className="font-semibold text-text-2">Status</dt>
              <dd className="text-body">{orEmpty(membership.status)}</dd>
              <dt className="font-semibold text-text-2">Member ID</dt>
              <dd className="text-body">{orEmpty(membership.memberId)}</dd>
            </dl>
            {membership === primary && <PrimaryBadge />}
          </div>
        </li>
      ))}
    </Section>
  );
}

/** Format the numeric match score, or the empty indicator when absent (Req 15.6). */
function formatScore(score: number | undefined): string {
  return typeof score === 'number' && !Number.isNaN(score) ? String(score) : EMPTY_INDICATOR;
}
