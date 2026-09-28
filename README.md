# PhoneMail

PhoneMail is a mobile-first email-style messaging prototype. A verified phone number maps to a PhoneMail address such as `919876543210@phonemail.com`. PhoneMail users can search for each other by number and exchange messages in chat-style conversations. The same responsive client provides a Gmail-like desktop layout and can be installed as a PWA on supported mobile browsers.

## Run with Docker

Install Docker Desktop, then from this directory run:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

Open <http://localhost:5173>. The default compose profile runs the development client and API; PostgreSQL data is kept in the `phonemail-data` Docker volume. To stop the services, run `docker compose down` (the database volume is retained).

In the default development configuration, OTP is generated locally and shown in the client. It does not send a real SMS. Create two accounts with different international phone numbers, then search for the other number to start composing. The recipient must have verified a PhoneMail account first.

## Features

- Phone number plus OTP onboarding; optional password mode when `AUTH_MODE=password` is selected.
- Four mobile onboarding screens, WebOTP-assisted SMS code entry where the browser supports it, and a compact web registration page at `/register`.
- Chat-style conversations, quick reply and traditional compose, drafts, group chats, search, unread/favorite/attachment filters, spam and trash states.
- Profile details, language, avatar URL, and additional `@phonemail.com` alias IDs.
- Installable responsive PWA. The browser cannot read the SIM phone number directly; users enter or edit their number. Contact access is requested only after choosing the Contacts button, where supported.
- Toll-free/voice and SMS account creation webhooks, plus inbound-email webhook for an email provider or gateway.
- SMS email notifications for users without an installed mobile app, when Twilio Messaging is configured.

## Live OTP and Twilio trial setup

For real OTP delivery, set `OTP_PROVIDER=twilio` in `.env` and configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`. Create a Verify service in Twilio Console. Restart with `docker compose up -d --build` after changing configuration.

Twilio trial accounts restrict the destination numbers that can receive verification/messages and apply trial message templates/limits. Verify each test destination in the Twilio console before testing. Trial availability and limits can change; see the [Twilio Verify trial guide](https://www.twilio.com/docs/usage/trials/try-out-verify) and [trial account guide](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account). No Twilio secret belongs in Git or chat.

If OTP cannot be configured, set `AUTH_MODE=password`. This prototype then creates an account using the provided phone number and password; it does not verify ownership of that number. Choose `AUTH_MODE=otp` for normal use.

## IVR, SMS signup, and email gateway

Expose the service over HTTPS and set `APP_URL` to its public origin. In Twilio Console, configure the trial/Twilio number's Voice webhook as `POST https://YOUR_HOST/api/webhooks/twilio/voice` and its Messaging webhook as `POST https://YOUR_HOST/api/webhooks/twilio/sms`. A voice caller presses `1`; an SMS sender replies `START` or `1`. Twilio signs webhook requests, so set the correct `APP_URL` and auth token.

The notification sender needs `TWILIO_FROM_NUMBER` plus the Twilio credentials. If the account is still on trial, test only with destinations approved by Twilio. The notification text is `You have received an email from <Sender>. Subject: <Subject>.` The trial may apply provider-owned templates instead of this custom body.

To deliver external email into PhoneMail, configure an inbound email provider to POST JSON to `/api/webhooks/email/inbound` with `X-PhoneMail-Webhook-Secret: <INBOUND_WEBHOOK_SECRET>` and a body like:

```json
{
  "fromEmail": "alex@example.net",
  "fromName": "Alex",
  "to": ["919876543210@phonemail.com"],
  "subject": "Hello",
  "text": "A message for PhoneMail"
}
```

This repository supplies the authenticated inbound webhook, not an email-domain/MX service or outbound SMTP relay. To receive external email, point a provider you control at the webhook and use a domain/mail provider configured for that purpose.

## Production

Before public deployment, set a strong random `JWT_SECRET`, a non-default `POSTGRES_PASSWORD`, `NODE_ENV=production`, `APP_URL`, and provider secrets in an untracked `.env` file. Set `OTP_PROVIDER=twilio` for live OTP. Then run `docker compose up -d --build`; open the app on port `3000` behind HTTPS. The server refuses to start in production with the default JWT secret.

## Important prototype limits

- This is a PWA/web client, not a native Android or iOS app. It cannot request native SIM-reading permissions; browser-based SMS OTP auto-fill is opportunistic and manual entry remains available.
- PhoneMail-to-PhoneMail sending is implemented. External inbound messages need the webhook integration described above; outbound SMTP and MX hosting are not included.
- Twilio credentials, a Twilio number, verified test recipients, and an externally reachable HTTPS endpoint are operator-provided; `docker compose up -d` alone does not deliver real SMS/OTP or create a toll-free number.
- The included Terms page is prototype copy. A service operator should replace it with reviewed terms and privacy details before public launch.
