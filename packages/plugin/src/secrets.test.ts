import { describe, expect, it } from "vitest"
import { isSecretPath } from "./secrets.js"

describe("isSecretPath", () => {
  it("catches env files, keys and credential files", () => {
    for (const p of [".env", "app/.env.local", "prod.env", "certs/server.pem", "deploy/id_ed25519", "id_rsa.pub", ".npmrc", "home/.aws/config", "gcp/service-account-prod.json", "infra/prod.tfvars", "config/credentials.json"]) {
      expect(isSecretPath(p), p).toBe(true)
    }
  })
  it("lets templates and ordinary source through", () => {
    for (const p of [".env.example", "app/.env.sample", "config/.env.template", "src/keyboard.ts", "docs/environment.md", "README.md", "package.json", "src/secretsManager.ts"]) {
      expect(isSecretPath(p), p).toBe(false)
    }
  })
})
