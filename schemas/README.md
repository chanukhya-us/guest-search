# schemas/

Reserved for the authoritative SOAP contract files supplied by IHG (Blocker B1):

- The Guest Search WSDL
- Every XSD it imports (common, initiate, complex, servicetypes, basictypes)

Keep the original file names so `import`/`include` locations resolve. When these files are present, the XSD test harness (`apps/bff/test/xsd/`) validates every generated request envelope against them with xmllint-wasm; when absent, those tests are skipped with a "B1: schemas not supplied" message.

Do not hand-edit supplied schemas. Record any discrepancy in `docs/` instead.
