# Lessons from reviewing agent MRs

- Don't assert on generated ids (`pay_…`, `ord_…`) beyond their prefix.
- After any rejected write (400/409/422), read the resource back and assert it did not change.
- Prefer one behaviour per test; name the test after the behaviour, not the status code.
