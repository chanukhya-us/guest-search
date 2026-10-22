# samples/

Reserved for sanitized SOAP request and response samples from the real service (Blocker B2):

- `searchGuestRequest` envelopes, including the SOAP header
- `searchGuestResponse` envelopes: single guest, multiple guests, empty, unsuccessful `transactionStatus`, SOAP Fault

Every sample must be sanitized before it is added: no real names, emails, phone numbers, addresses, member IDs, enterprise IDs, card data, credentials or tokens. Replace them with obviously synthetic values.

The synthetic fixtures used by tests and WireMock live with the tests, not here. Samples are the reference those fixtures are checked against.
