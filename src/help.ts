/**
 * The help system (specs/18-cli-help.md).
 *
 * Built on commander's built-ins only (D12, D24): command groups via
 * helpGroup(), a small formatHelp override for the root command, per-command
 * Examples via addHelpText('after'), and a hidden `help [topic]` command for
 * topics and `thoughts help <command>`. No new dependency.
 */
import { Command, Help, Option } from 'commander';
import { HELP_TOPICS, findTopic } from './help-topics.js';
import * as out from './output.js';
import { ExitCode, ThoughtsError } from './types.js';

/** The literal marker every planned command carries (specs/18). */
const NOT_IN_THIS_VERSION = 'not in this version';

/** Commands that have a spec but no implementation in this version. */
interface PlannedCommand {
  readonly name: string;
  readonly description: string;
  /** Spec the implementation will follow, named in the refusal message. */
  readonly spec?: string;
}

const PLANNED_COMMANDS: readonly PlannedCommand[] = [
  { name: 'search', description: 'Search thoughts across all repos', spec: 'specs/05-cli-search.md' },
  { name: 'attach-all', description: 'Clone and register every repo in a brain at once', spec: 'specs/13-cli-attach-all.md' },
  { name: 'worktree', description: 'Git worktrees with the brain symlink in place', spec: 'specs/14-cli-worktree.md' },
  { name: 'doctor', description: 'Diagnose brain, symlink, kit, and config problems' },
  { name: 'kit', description: 'Inspect and update the standard kit', spec: 'specs/08-standard-kit.md' },
];

/** Fixed group order and membership (specs/18 "Grouped command list"). */
const COMMAND_GROUPS: ReadonlyArray<{ heading: string; commands: readonly string[] }> = [
  { heading: 'Getting started', commands: ['init'] },
  { heading: 'Daily', commands: ['new', 'status'] },
  { heading: 'Maintenance', commands: ['sync', 'scan'] },
  { heading: `Planned (${NOT_IN_THIS_VERSION})`, commands: PLANNED_COMMANDS.map((c) => c.name) },
];

/** Global options every command accepts; documented once, rendered by hand because they are declared per command. */
const GLOBAL_OPTIONS: readonly Option[] = [
  new Option('--brain <id|url>', 'brain to use when outside a repo: a remote URL, clone id, or local path'),
  new Option('--json', 'print machine-readable JSON'),
  new Option('-q, --quiet', 'suppress informational output'),
  new Option('-v, --version', 'print the CLI version'),
  new Option('-h, --help', 'show help for a command'),
];

/** The two or three invocations a Dev actually types (specs/18 "Per-command examples"). */
const COMMAND_EXAMPLES: ReadonlyArray<{ command: string; text: string }> = [
  {
    command: 'init',
    text: `Examples:
  thoughts init                          # create a fresh brain and attach this repo
  thoughts init --brain git@github.com:acme/acme-brain.git
  thoughts init --yes                    # teammate: after cloning the code repo, reuse .thoughts.yml`,
  },
  {
    command: 'sync',
    text: `Examples:
  thoughts sync                 # pull, regenerate indexes, commit, push
  thoughts sync --pull-only     # just see what came in from other repos
  thoughts sync --no-push       # commit locally, push later
  # on exit 4 (conflict): resolve the named file in ~/.thoughts/brains/<brain-id>/, then re-run thoughts sync`,
  },
  {
    command: 'status',
    text: `Examples:
  thoughts status                       # drafts, recent edits and stale thoughts across the project
  thoughts status --json | jq -r '.rows[] | "\\(.kind)  \\(.title)"'
  thoughts status --since 3d
  thoughts status --mine --kind specs`,
  },
  {
    command: 'new',
    text: `Examples:
  thoughts new spec "Refund endpoint v2"        # into this repo: repos/<repo-id>/specs/
  thoughts new decision --shared "Use FTS5"     # project-wide: shared/decisions/
  thoughts new research --user "Token costs"    # personal scratch: users/<me>/`,
  },
  {
    command: 'scan',
    text: `Examples:
  thoughts scan                # scan the whole brain
  thoughts scan --staged       # what the brain's pre-commit hook runs
  # scan --history / --fix / --allow: not in this version (specs/15)`,
  },
];

/**
 * Root-command help: stock layout, but the commands render in four fixed
 * groups (specs/18) and a global options block follows them. Subcommands keep
 * the stock layout — this override only ever sees the program (and, via
 * configuration inheritance, commands that delegate through it).
 */
function formatRootHelp(cmd: Command, helper: Help): string {
  if (cmd.parent !== null) return Help.prototype.formatHelp.call(helper, cmd, helper);

  // Usage and description, exactly as stock.
  let output = [`${helper.styleTitle('Usage:')} ${helper.styleUsage(helper.commandUsage(cmd))}`, ''];
  const description = helper.commandDescription(cmd);
  if (description.length > 0) {
    output = output.concat([helper.boxWrap(helper.styleCommandDescription(description), helper.helpWidth ?? 80), '']);
  }

  // Command groups, in the fixed order above, terms as bare command names
  // (specs/18 "Grouped command list"); flags and arguments stay in the
  // command's own help.
  const visible = helper.visibleCommands(cmd);
  const nameWidth = Math.max(...visible.map((c) => c.name().length));
  for (const group of COMMAND_GROUPS) {
    const commands = visible.filter((c) => c.helpGroup() === group.heading);
    if (commands.length === 0) continue;
    const items = commands.map((sub) =>
      helper.formatItem(
        helper.styleSubcommandTerm(sub.name()),
        nameWidth,
        helper.styleSubcommandDescription(helper.subcommandDescription(sub)),
        helper,
      ),
    );
    output = output.concat(helper.formatItemList(group.heading, items, helper));
  }

  // Global options block, after the groups.
  const optionWidth = Math.max(...GLOBAL_OPTIONS.map((o) => helper.optionTerm(o).length));
  const optionItems = GLOBAL_OPTIONS.map((option) =>
    helper.formatItem(
      helper.styleOptionTerm(helper.optionTerm(option)),
      optionWidth,
      helper.styleOptionDescription(helper.optionDescription(option)),
      helper,
    ),
  );
  output = output.concat(helper.formatItemList('Global options:', optionItems, helper));

  return output.join('\n');
}

/** After-text for the root help: the typical session and the topic pointer (specs/18 "Typical session"). */
function rootAfterText(): string {
  const topicLines = HELP_TOPICS.map((t) => `  ${t.name.padEnd(11)}${t.summary}`);
  return `
Typical session:
  thoughts init                    # once per repo
  thoughts new plan "<title>"      # capture thinking where it happens
  # ... work, plan, spec with your assistant ...
  thoughts sync                    # share and receive brain changes
  thoughts status                  # what is in flight project-wide

Help topics (thoughts help <topic>):
${topicLines.join('\n')}`;
}

/** Register a planned command: listed in help, refused when invoked. */
function registerPlanned(program: Command, planned: PlannedCommand): void {
  program
    .command(planned.name)
    .description(planned.description)
    .helpGroup(`Planned (${NOT_IN_THIS_VERSION})`)
    .action(async () => {
      const where = planned.spec === undefined ? '' : ` See ${planned.spec} when it lands.`;
      throw new ThoughtsError(`thoughts ${planned.name}: ${NOT_IN_THIS_VERSION}`, ExitCode.Validation, {
        hint: where.length > 0 ? where.trim() : undefined,
      });
    });
}

/** `thoughts help [<topic>|<command>]`. Hidden, so it does not appear in the grouped list. */
function registerHelpCommand(program: Command): void {
  program
    .command('help [topic]', { hidden: true })
    .description('Show help for a command or a topic')
    .action(async (topic?: string) => {
      // No topic: the root help (grouped list, global options, topics pointer).
      if (topic === undefined) {
        program.outputHelp();
        return;
      }
      // Topic first, then command (specs/18 "thoughts help <topic>").
      const topicText = findTopic(topic);
      if (topicText !== undefined) {
        out.print(topicText.text.replace(/\n+$/, ''));
        return;
      }
      const command = program.commands.find((c) => c.name() === topic);
      if (command !== undefined) {
        command.outputHelp();
        return;
      }
      throw new ThoughtsError(`unknown topic "${topic}"`, ExitCode.Validation, {
        hint: `available topics: ${HELP_TOPICS.map((t) => t.name).join(', ')} — or: thoughts help <command>`,
      });
    });
}

/**
 * Attach the per-command Examples block. COMMAND_EXAMPLES is the single owner
 * of every shipped command's after-text, so nothing is attached twice.
 */
function addCommandExamples(program: Command): void {
  for (const example of COMMAND_EXAMPLES) {
    const command = program.commands.find((c) => c.name() === example.command);
    if (command === undefined) continue;
    command.addHelpText('after', `\n${example.text}`);
  }
}

/**
 * Wire the whole help system onto a fully registered program. Called once,
 * after every shipped command has registered (specs/18-cli-help.md).
 */
export function applyHelp(program: Command): void {
  for (const planned of PLANNED_COMMANDS) registerPlanned(program, planned);

  for (const group of COMMAND_GROUPS) {
    for (const name of group.commands) {
      program.commands.find((c) => c.name() === name)?.helpGroup(group.heading);
    }
  }

  addCommandExamples(program);
  registerHelpCommand(program);

  // specs/18 "Error-path help": commander 14 spells this showSuggestionAfterError.
  program.showSuggestionAfterError();
  program.addHelpText('after', rootAfterText());
  program.configureHelp({ formatHelp: formatRootHelp });
}
