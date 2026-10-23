// Files that look like secrets never leave this machine on their own: untracked ones
// are kept out of the snapshot, and any are kept out of inputs. The agent is told
// what was left out, so it can ask for something else instead of guessing.

const TEMPLATE = /\.(example|sample|template|dist|defaults?|tmpl)$/i
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker", ".azure", ".gcloud"])
const SECRET_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  ".htpasswd",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "secrets.toml",
  "terraform.tfstate",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
])
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|p8|jks|keystore|kdbx|ppk|asc|gpg|tfvars|tfstate|secret|secrets|mobileprovision|cer|crt)$/i

/** Repository-relative path (forward slashes) that looks like it holds secrets. */
export function isSecretPath(path: string): boolean {
  const parts = path.split("/")
  const name = parts[parts.length - 1]!.toLowerCase()
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))) return true
  if (TEMPLATE.test(name)) return false
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return true
  if (SECRET_NAMES.has(name)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return true
  if (/^(service[-_]?account|client[-_]?secret|credentials?)[^/]*\.json$/.test(name)) return true
  return SECRET_EXTENSIONS.test(name)
}

/** Keeps the report readable when a folder holds many. */
export function summarizeSkipped(paths: string[], max = 20): string {
  return paths.length <= max ? paths.join(", ") : `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`
}
