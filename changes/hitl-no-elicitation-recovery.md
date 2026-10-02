---
type: Fixed
---
- **A client without elicitation now gets the full mint command in `recovery`.** When the connected client cannot show a confirmation prompt, the `elicit_required` error's structured `recovery` still carried the stock `obsidian-tc elicit --hash <args_hash> --tool <name>` placeholder, while the text channel and the cancelled-prompt paths rendered the complete command. A client that followed it minted a token for caller `stdio` and redemption failed closed for any other caller. `recovery` now renders the same command as the text channel (vault and caller included, shell-quoted); the message is unchanged. An explicit `decline` is still a hard stop with no mint route. The security docs now note that the caller id appears in the model-visible error and the pasted command.
