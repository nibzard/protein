# Cloudflare Agents compatibility probe

This probe intentionally imports the current pinned `agents` package and uses
only its base `Agent` state API. It answers a narrow question: can an ordinary
Cloudflare Agent bundle deploy and execute on celld without a Protein shim?

The probe is kept separate from the Protein runtime so a build or deployment
failure remains evidence rather than becoming hidden by compatibility code.

Run it through the celld integration script. The script records the
deployment/runtime result and version information under `artifacts/compat/`.
