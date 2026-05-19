# RFC 8058 one-click unsubscribe testing

Turbolong alert emails include both unsubscribe mechanisms required for major email clients:

- `List-Unsubscribe: <https://turbolong-alerts.workers.dev/unsubscribe?token=...>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`

Verification emails and APY alert emails both include these headers because both are outgoing subscription-related emails.

## Manual email-client test

1. Subscribe to an alert with a mailbox that exposes message headers, such as Gmail or Outlook.
2. Open the verification email and inspect the raw source.
3. Confirm both `List-Unsubscribe` and `List-Unsubscribe-Post` are present.
4. Verify that the `List-Unsubscribe` URL contains the subscription `unsub_token`.
5. Send a one-click POST request to the URL:

   ```sh
   curl -i -X POST "https://turbolong-alerts.workers.dev/unsubscribe?token=<token>"
   ```

6. Expected result: the worker returns `204 No Content` and deletes the subscription.
7. Repeating the same POST should return `404`, confirming the token was already removed.

The ordinary GET `/unsubscribe?token=...` path remains available for users who click the visible unsubscribe link in the email footer.
