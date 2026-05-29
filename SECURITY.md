# Security and Responsible Disclosure

Thank you for taking the time to responsibly disclose security vulnerabilities affecting TurboLong. This document explains how to report issues, how we triage and respond, and the disclosure timeline.

## Reporting

- Preferred channel: Open a private GitHub Security Advisory for this repository: https://github.com/Dgetsylver/TurboLong/security/advisories
- If you cannot use GitHub Security Advisories, send an encrypted email to: security@dgetsylver.dev

We publish a PGP public key below for encrypted reports. If you send an encrypted email, include the following information where possible:

- A clear title and short summary
- Steps to reproduce (minimal test case or transaction data)
- Impact and any known mitigations
- Disclosure preferences and contact information

Example report template: see [BLEND-BUG-BOUNTY-REPORT.md](BLEND-BUG-BOUNTY-REPORT.md) for an exemplar report format.

## PGP key (for encrypted reports)

-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGoZp50BEAC2WKPNGXik09114d1yc4i1q5BF2no/X/gZ5huTULKIKINQ49aT
U0GUEfooKOhNW3fJTxRgC2lQVW4gfnRg8DQ7CvSMVmSbSIak2CBjsvlyC/YvTBFR
VLOLXzhkICndXaAROYdMMLP1e6nTg9xV8siFHMbuk6cOwMvinjeNGFdb3/wfnE4I
m5vIey8gtB/UFfg58kyO7Jk6e3qtuXuNWlXT17qmxBVf8c/It/Ps5P+bc/dkU6aP
Y0n9QZcDPxEAu7SW9+qosl10tCNwlKDfbXy10JP/ZOKSfTGx1j1Ly46Jy/QcSdKV
Qz++ZOHmL4bTWv+00eYMXaexmpZ+Z0trPgpbT1j28LN8i6aHEeooNQ8NhjGm7Umn
XPwl9YxPxSxe6kg+3r+xQFHA5ZuuldzJr2q5ETym9TuYAaJIHDSWJ3lTnrtr57Xn
vkGLrslxvKQkmYlOYA9L9eChbWRiOxRJVMw4fMJb1o+9cBfMMsXY0ILdIYFeCIjS
HB8xlVLx1LjfN7znyz5awqCWURD0ax6pShiTCOsqNM99/zO03cUct6BNoKxf+bZU
+0sV8sgEO6U8OFa5K05p01YzauukigMDgdsthQbbhB3SZy9YDhFK4iOs86xXPGZC
udX4I1dqbsicWGi1xvvayaofsW9FLRKe7KEze/7kiLJ38THWcIWK492lqwARAQAB
tERUdXJib0xvbmcgU2VjdXJpdHkgKFR1cmJvTG9uZyBwcm9qZWN0IGtleSkgPHNl
Y3VyaXR5QGRnZXRzeWx2ZXIuZGV2PokCUgQTAQoAPBYhBMl2dmvY10QPCCxHFChb
VNex6htqBQJqGaedAxsvBAULCQgHAgIiAgYVCgkICwIEFgIDAQIeBwIXgAAKCRAo
W1TXseobahxWD/sErK15eUvj6WM7EA3cEIWNteiTW3HU29pxgtBjo5t9EfXXDGI+
7xjvrMH0EtOKe9ilv+j0bAg76KjTLbD8bkwnO+mM6eci9C+IAOywNHimzuzRnpxp
ogeddzzhsMLPRiKit/RwPFklIr3dlw4LyxvG94pwRSHOOe6zhfWBJzIJkujdxhP5
lMsQ5v+4fUXeQ5OPduJE8gLNqCw7AeqIiGAawkjg5uVDv+l1pqYU+Y50Z2DF4gFZ
/ypgD+TGemjZsx+kJilVkVaTkeWLbmm25mF1TvNmvf9DSkXNWizDiLR53GQLRyzx
juycmFUq1/WcDWtaWk682hu/DaCDQDfYKkzU/ea1+EtD6eIfl78GDqs2AthFP6oD
4SGN0omf/cGAmKCMLrQlyYUmy/uHUCNS92TBlGe0dyfrQ5re56QuW1CovmRsPmHu
w8mGXeq7XAo0foYmPS/r7bvZqignTs8fY0un2zaGek0v7Vhhh69CeogBaZULOR0Z
2PrivN+ylsOvLbOLOlrthQNSCPq4I/hryFn30F4zKYDyZd4o7/qFhCEPaAjGr40p
v11g/Y3ytKkWfNgGNNQxLyC83o1EVPxqXefCbJgtOz4XhTgfxbE8qpS8/9II8e/0
tuS9p0iVb5KvQaPs8ZWSTPgM29cXzqa761IZ+NxYMozfVdwTVvoryKlbNQ==
=VZSn
-----END PGP PUBLIC KEY BLOCK-----

This is the project's public key. Keep the private key secure — it is not stored in this repository. If you prefer another secure channel, contact us via the GitHub Security Advisory flow.

## Triage and Response Process

1. Acknowledgement: We will acknowledge receipt within 3 business days.
2. Triage: We will triage the report and assign a severity within 7 business days.
3. Fixing: Our team will work to develop a fix and deploy mitigations as soon as practicable.
4. Coordination: We will coordinate with you on disclosure timing and crediting.

## Responsible Disclosure Window

We follow a 90-day disclosure policy by default: we ask reporters to allow up to 90 days for coordinated disclosure and remediation. We may extend or shorten this window for high-severity issues, active exploitation, or regulatory requirements. If you request extended embargo, we will consider it on a case-by-case basis.

## Scope

Report security issues in this repository and the associated contracts, frontend, and alerting systems. Do not include claims about unrelated third-party services.

## Safe Harbor

If you follow this policy, act in good faith, and avoid data exfiltration or sustained disruption, we will not pursue legal action against you for the testing described in your report. This does not cover activities that exceed the scope above or violate applicable law.

## Acknowledgements and Bounty

We will credit researchers who responsibly disclose vulnerabilities unless they ask to remain anonymous. This repository currently does not have an automated bounty program; for bounty details see BLEND-BUG-BOUNTY-REPORT.md or contact the maintainers.

## Contact

- GitHub Security Advisory: https://github.com/Dgetsylver/TurboLong/security/advisories
- Encrypted email: security@dgetsylver.dev (use the PGP key above)

If you don't receive a timely response using the channels above, open an issue mentioning `security` and we will escalate.
