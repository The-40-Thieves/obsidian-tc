export const WEBHOOK_SECRET_VARIABLE = "OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET";
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** Refuses a webhook secret too short to be worth accepting. The error names the variable and
 *  never the value. Shared by the server's route and the git-sync sidecar, which read the same
 *  variable, so both stop at the same boundary. */
export function assertWebhookSecret(secret: string): void {
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `${WEBHOOK_SECRET_VARIABLE} must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
    );
  }
}
