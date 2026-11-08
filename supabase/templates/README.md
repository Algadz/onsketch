# Auth email templates

Paste into Supabase → Authentication → Emails (Templates tab), one per template:

| File | Template | Subject |
|---|---|---|
| `magic-link.html` | Magic Link | `Your OnSketch sign-in code: {{ .Token }}` |
| `confirm-signup.html` | Confirm signup | `Welcome to OnSketch: confirm your email` |

`{{ .Token }}` is the code typed in the editor's sign-in dialog;
`{{ .ConfirmationURL }}` is the sign-in link. The logo is loaded from
`https://onsketch.io/assets/brand/google-logo-120.png` (PNG: mail apps don't show SVG).
Sent by Resend from `noreply@onsketch.io` (custom SMTP in Supabase).
