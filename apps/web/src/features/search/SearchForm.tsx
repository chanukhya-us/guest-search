// SearchForm: the IHG guest search criteria form (Req 3, 4, 5, 9.4/9.5, 23, 24).
//
// What this component owns (task 12.3):
//   - The 12 criteria fields in Req 3.2 order, each labelled, in a responsive grid
//     (4/3/2/1 columns, Req 3.10).
//   - Client validation via the SHARED schema, built from UiConfig so the browser
//     enforces exactly what the BFF enforces (createCriteriaSchema + zodResolver).
//     Validation runs on submit (Req 5.1); Enter submits (Req 3.9).
//   - Feature-flag gating (Req 9.4): addressLine1, city and postalCode are disabled
//     unless UiConfig.features enables them; addressLine2 is always disabled (Req 3.5).
//     Disabled fields show the "Not yet available" helper and, being empty, normalize
//     away so they are never part of the submitted criteria.
//   - Accessible errors (Req 5): an ErrorSummary that takes focus with one link per
//     problem, plus inline "Error:" messages wired by aria-describedby / aria-invalid.
//     The form-level NO_CRITERIA message (schema root issue) is surfaced in the summary.
//   - Search + Clear actions (Req 3.6, 3.8). Clear resets everything, announces
//     "Search cleared" and focuses First Name.
//
// What this component does NOT do: it never calls the search API. On a valid submit it
// hands the normalized criteria (the schema output) up through onSearch; the mutation,
// loading state and results live in the controller (task 12.4). It accepts `submitting`
// to disable itself while a search runs, and `serverErrors` to map a BFF
// VALIDATION_ERROR / NO_CRITERIA response into the same error UI (Req 5.7).
import {
  CRITERIA_FIELDS,
  createCriteriaSchema,
  defaultSchemaConfig,
  NO_CRITERIA_MESSAGE,
  type CriteriaField,
  type GuestSearchQuery,
  type UiConfig,
} from '@ihg-guest-search/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';

import { useStatusRegion } from '../../a11y/StatusRegion.js';
import { EraseIcon, SearchIcon, Spinner } from '../../components/icons.js';
import { FIRST_NAME_INPUT_ID } from '../../a11y/useShortcut.js';
import { ErrorSummary, type SummaryItem } from './ErrorSummary.js';
import { CountryComboBox } from './fields/CountryComboBox.js';
import { buildCountryOptions } from './fields/countryOptions.js';
import { FIELD_META, NOT_YET_SUPPORTED } from './fields/fieldMeta.js';
import { MemberTypeSelect } from './fields/MemberTypeSelect.js';
import { TextField } from './fields/TextField.js';

/** Form values: every field is a string with a "" default (controlled/registered). */
export type CriteriaFormValues = Record<CriteriaField, string>;

/** A field error returned by the BFF (Req 5.7); `field` may be the form-level "root". */
export interface ServerFieldError {
  field: CriteriaField | 'root';
  message: string;
}

interface SearchFormProps {
  config: UiConfig;
  /** Receives the validated, normalized criteria on a valid submit. */
  onSearch: (criteria: GuestSearchQuery) => void;
  /** Disable the form and show "Searching…" while a search is in flight (Req 18.1). */
  submitting?: boolean;
  /** BFF validation errors to render in the same summary/inline UI (Req 5.7). */
  serverErrors?: readonly ServerFieldError[];
  /**
   * Notifies the controller that Clear was pressed, so it can reset the results region
   * to idle (design.md state machine: every state → idle on Clear). The form still owns
   * resetting its own fields, errors, focus and the "Search cleared" announcement.
   */
  onClear?: () => void;
}

// The shared schema reports the "at least one criterion" issue with path: [], which
// the resolver stores under the empty-string key in the RHF error map (verified
// against the installed @hookform/resolvers + Zod 4). We read client root errors from
// that key; server NO_CRITERIA errors are held in local state (setError with an empty
// name is not part of the RHF contract).
const CLIENT_ROOT_KEY = '';

function emptyValues(): CriteriaFormValues {
  return Object.fromEntries(CRITERIA_FIELDS.map((f) => [f, ''])) as CriteriaFormValues;
}

export function SearchForm({
  config,
  onSearch,
  submitting = false,
  serverErrors,
  onClear,
}: SearchFormProps) {
  const { announce } = useStatusRegion();

  // The schema is rebuilt only when the member-type code set changes. Client
  // validation then matches the server exactly (both use the shared factory).
  const schema = useMemo(
    () => createCriteriaSchema({ ...defaultSchemaConfig, memberTypes: config.memberTypes }),
    [config.memberTypes],
  );

  // zodResolver detects the Zod 4 schema at runtime; the output type is the schema's
  // (GuestSearchQuery). We type the form by its string values, so cast the resolver.
  const resolver = useMemo(
    () => zodResolver(schema) as unknown as Resolver<CriteriaFormValues>,
    [schema],
  );

  const countryOptions = useMemo(() => buildCountryOptions(), []);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CriteriaFormValues>({
    resolver,
    defaultValues: emptyValues(),
    // Validate on submit (Req 5.1); re-validate on change once a field has errored so
    // corrections clear quickly (Req 5.6).
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    // We move focus to the ErrorSummary ourselves (Req 5.2); RHF's default of focusing
    // the first errored field would otherwise win the race.
    shouldFocusError: false,
  });

  // Bumped on every failed submit so the ErrorSummary re-takes focus (Req 5.2) even
  // when the same errors remain.
  const [focusToken, setFocusToken] = useState(0);

  // Server-reported form-level error (BFF NO_CRITERIA, Req 5.7). Held separately
  // because its RHF path is the empty string, which setError does not accept.
  const [serverRootMessage, setServerRootMessage] = useState<string | undefined>(undefined);

  /** True when a field is disabled by a feature flag or is always-off Address Line 2. */
  function isDisabled(field: CriteriaField): boolean {
    const meta = FIELD_META.find((m) => m.field === field);
    if (!meta) return false;
    if (meta.alwaysDisabled) return true;
    if (meta.featureFlag) return !config.features[meta.featureFlag];
    return false;
  }

  // Apply BFF field errors (Req 5.7) into the same error UI, then refocus the summary.
  // Field errors go through RHF setError; the form-level "root" error goes to local
  // state (its RHF path is the empty string).
  useEffect(() => {
    if (!serverErrors || serverErrors.length === 0) return;
    let root: string | undefined;
    for (const e of serverErrors) {
      if (e.field === 'root') {
        root = e.message;
      } else {
        setError(e.field, { type: 'server', message: e.message });
      }
    }
    setServerRootMessage(root);
    setFocusToken((n) => n + 1);
  }, [serverErrors, setError]);

  function onValid(values: CriteriaFormValues): void {
    // A successful client validation clears any stale server root error.
    setServerRootMessage(undefined);
    // The resolver has already normalized the values to the schema output shape; parse
    // once more to hand onSearch the exact GuestSearchQuery the BFF will receive.
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      // Should not happen (onValid only runs when the resolver passed), but stay safe.
      setFocusToken((n) => n + 1);
      return;
    }
    onSearch(parsed.data);
  }

  function onInvalid(): void {
    // A fresh client failure supersedes any prior server root error.
    setServerRootMessage(undefined);
    setFocusToken((n) => n + 1);
  }

  function handleClear(): void {
    reset(emptyValues());
    clearErrors();
    setServerRootMessage(undefined);
    onClear?.();
    announce('Search cleared');
    document.getElementById(FIRST_NAME_INPUT_ID)?.focus();
  }

  // Build the ErrorSummary items from the current errors, in field order, with the
  // form-level (root) error first. The client root error lives under the empty key;
  // a server NO_CRITERIA lives in serverRootMessage.
  const errorMap = errors as Record<string, { message?: string } | undefined>;
  const rootMessage = errorMap[CLIENT_ROOT_KEY]?.message ?? serverRootMessage;
  const summaryItems = buildSummaryItems(rootMessage, errorMap);

  return (
    <form
      noValidate
      aria-label="Guest search"
      onSubmit={handleSubmit(onValid, onInvalid)}
      className="overflow-hidden rounded-card bg-surface shadow-panel ring-1 ring-border/60"
    >
      {/* Decorative brand accent along the top edge of the card. */}
      <div
        aria-hidden="true"
        className="h-1 bg-gradient-to-r from-primary via-decorative to-navy"
      />

      <div className="p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-xl font-semibold text-navy">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-navy-wash text-navy">
              <SearchIcon size={16} />
            </span>
            Search criteria
          </h2>
          <p className="text-sm text-text-2">
            Enter at least one field. More fields, sharper matches.
          </p>
        </div>

        <ErrorSummary items={summaryItems} focusToken={focusToken} />

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {FIELD_META.map((meta) => {
            const disabled = isDisabled(meta.field);
            const fieldError = errors[meta.field]?.message;
            const helper = disabled ? NOT_YET_SUPPORTED : undefined;

            if (meta.kind === 'country') {
              return (
                <Controller
                  key={meta.field}
                  name={meta.field}
                  control={control}
                  render={({ field }) => (
                    <CountryComboBox
                      inputId={meta.inputId}
                      label={meta.label}
                      options={countryOptions}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      error={fieldError}
                    />
                  )}
                />
              );
            }

            if (meta.kind === 'memberType') {
              return (
                <Controller
                  key={meta.field}
                  name={meta.field}
                  control={control}
                  render={({ field }) => (
                    <MemberTypeSelect
                      inputId={meta.inputId}
                      label={meta.label}
                      options={config.memberTypes}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      error={fieldError}
                    />
                  )}
                />
              );
            }

            return (
              <TextField
                key={meta.field}
                inputId={meta.inputId}
                label={meta.label}
                autoComplete={meta.autoComplete}
                type={meta.inputType}
                disabled={disabled}
                helper={helper}
                error={fieldError}
                registration={register(meta.field, { disabled })}
              />
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border/70 pt-5">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-12 items-center gap-2 rounded-control bg-primary px-6 text-base font-medium text-surface shadow-sm transition duration-150 hover:-translate-y-px hover:bg-primary-hover hover:shadow-md active:translate-y-0 disabled:translate-y-0 disabled:opacity-60 disabled:shadow-none"
          >
            {submitting ? <Spinner /> : <SearchIcon size={18} />}
            {submitting ? 'Searching…' : 'Search'}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={submitting}
            className="inline-flex h-12 items-center gap-2 rounded-control border border-navy px-6 text-base font-medium text-navy transition duration-150 hover:bg-navy-wash disabled:opacity-60"
          >
            <EraseIcon size={16} />
            Clear
          </button>
          <p className="ml-auto hidden text-sm text-text-2 md:block">
            Tip: press <kbd className="kbd">Enter</kbd> in any field to search
          </p>
        </div>
      </div>
    </form>
  );
}

/** Lazy label lookup for the summary links. */
function labelFor(field: CriteriaField): string {
  return FIELD_META.find((m) => m.field === field)?.label ?? field;
}

/** Input id to focus for a given field (First Name owns the shortcut id). */
function inputIdFor(field: CriteriaField): string {
  return FIELD_META.find((m) => m.field === field)?.inputId ?? `criteria-${field}`;
}

/**
 * Turn the current errors into ordered summary items. The root (form-level) error —
 * the schema's "at least one criterion" issue or a server NO_CRITERIA — comes first
 * and links to the First Name input. Field errors follow in Req 3.2 order.
 */
function buildSummaryItems(
  rootMessage: string | undefined,
  errors: Record<string, { message?: string } | undefined>,
): SummaryItem[] {
  const items: SummaryItem[] = [];

  if (rootMessage) {
    items.push({
      inputId: FIRST_NAME_INPUT_ID,
      label: 'Search criteria',
      message: rootMessage,
    });
  }

  for (const field of CRITERIA_FIELDS) {
    const message = errors[field]?.message;
    if (message) {
      items.push({ inputId: inputIdFor(field), label: labelFor(field), message });
    }
  }

  return items;
}

/** Re-exported for tests that assert the exact root message. */
export { NO_CRITERIA_MESSAGE };
