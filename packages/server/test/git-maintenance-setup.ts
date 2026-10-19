// Switch git auto maintenance off for every git child of the server suite. Its tests run git
// commits in temp repos, and a detached `git maintenance run --auto` left by a commit can outlive
// the test and recreate the fixture directory after it was removed (git-maintenance-off.test.ts).
// Vitest workers and the git children they spawn inherit process.env, so one assignment covers
// every test file. withGitMaintenanceOff is idempotent, so a worker that runs this file again for
// the next test file does not stack a second entry.
import { withGitMaintenanceOff } from "../../../scripts/lib/git-maintenance.mjs";

Object.assign(process.env, withGitMaintenanceOff(process.env));
