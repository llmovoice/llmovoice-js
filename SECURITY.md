# Security policy

## Supported versions

Until the first stable release, security fixes are published on the newest `0.x` release line only.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for `llmovoice/llmovoice-js`. Do not include credentials, personal data, call recordings, or exploit details in a public issue. Include the affected package/version, impact, reproduction, and any suggested mitigation. We aim to acknowledge a report within three business days; this is a response target, not a service-level agreement.

## Deployment boundary

llmovoice.js does not provide end-user authentication or authorization. Deployments must:

- keep standard provider keys in trusted server environments;
- authenticate every browser, phone, and messaging identity;
- authorize tenant-scoped Page and Thread access;
- verify webhook signatures before parsing or acting on events;
- use shared rate limiting across instances and cap provider spend;
- encrypt sensitive data and implement retention, export, and deletion policy;
- obtain consent and satisfy call-recording, messaging, and telephony law;
- audit tool and application directive executors as privileged code.

The included demo bearer gate and in-memory limiter reduce accidental exposure; they are not a replacement for production identity or distributed abuse prevention.
