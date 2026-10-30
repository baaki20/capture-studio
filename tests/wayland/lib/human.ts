/**
 * The human side of the harness: instructions printed in a box, waits for Enter, yes/no and
 * numbered choices on the terminal, and "do this now" prompts that end when the app reports the
 * expected event. With `auto` (dry runs, `--yes`) every prompt answers itself, so the whole run
 * can execute without anyone at the keyboard.
 */
import readline from 'node:readline';

const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export class Human {
  private rl: readline.Interface | null = null;
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string) => void)[] = [];
  /** Lines typed while an `act` prompt is waiting (only `skip` means something then). */
  private listener: ((line: string) => void) | null = null;
  /** Every instruction shown, for the report. */
  readonly transcript: string[] = [];

  constructor(readonly auto: boolean) {
    if (!auto) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('line', (line) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else if (this.listener) this.listener(line);
        else this.lines.push(line);
      });
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  info(text: string): void {
    console.log(`${CYAN}·${RESET} ${text}`);
  }

  /** A boxed instruction block. */
  instruct(title: string, steps: readonly string[]): void {
    this.transcript.push(`${title}: ${steps.join(' / ')}`);
    const width = Math.min(100, Math.max(title.length + 4, ...steps.map((s) => s.length + 6)));
    const bar = '─'.repeat(width);
    console.log(`\n${YELLOW}┌${bar}┐${RESET}`);
    console.log(`${YELLOW}│${RESET} ${BOLD}${title}${RESET}`);
    steps.forEach((step, i) => console.log(`${YELLOW}│${RESET}  ${String(i + 1)}. ${step}`));
    console.log(`${YELLOW}└${bar}┘${RESET}`);
    process.stdout.write('\x07');
  }

  private readLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Waits for Enter (auto: continues after a short pause). */
  async enter(prompt = 'Press Enter to continue'): Promise<void> {
    if (this.auto) {
      console.log(`${prompt} (auto)`);
      await new Promise((r) => setTimeout(r, 300));
      return;
    }
    process.stdout.write(`${BOLD}${prompt}${RESET} `);
    await this.readLine();
  }

  async yesNo(question: string, autoAnswer: boolean): Promise<boolean> {
    if (this.auto) {
      console.log(`${question} → ${autoAnswer ? 'y' : 'n'} (auto)`);
      return autoAnswer;
    }
    for (;;) {
      process.stdout.write(`${BOLD}${question}${RESET} [y/n] `);
      const answer = (await this.readLine()).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  }

  /** A line of free text (auto: `autoAnswer`). */
  async ask(question: string, autoAnswer = ''): Promise<string> {
    if (this.auto) {
      console.log(`${question} → ${autoAnswer} (auto)`);
      return autoAnswer;
    }
    process.stdout.write(`${BOLD}${question}${RESET} `);
    return (await this.readLine()).trim();
  }

  /** A numbered choice; returns the index (auto: `fallback`). */
  async choose(question: string, options: readonly string[], fallback: number): Promise<number> {
    console.log(`\n${BOLD}${question}${RESET}`);
    options.forEach((o, i) => console.log(`  ${String(i + 1)}) ${o}${i === fallback ? ' *' : ''}`));
    if (this.auto) {
      console.log(`→ ${String(fallback + 1)} (auto)`);
      return fallback;
    }
    for (;;) {
      process.stdout.write(`Number [${String(fallback + 1)}]: `);
      const answer = (await this.readLine()).trim();
      if (answer === '') return fallback;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    }
  }

  /**
   * Shows `steps` and resolves when `until` does (the app saw the action), or rejects after
   * `timeoutMs`. Typing `skip` gives up early.
   */
  async act<T>(title: string, steps: readonly string[], until: Promise<T>, timeoutMs: number) {
    this.instruct(title, steps);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no response within ${String(Math.round(timeoutMs / 1000))} s`)),
        timeoutMs,
      );
    });
    const skipped = new Promise<never>((_, reject) => {
      this.listener = (line) => {
        if (line.trim() === 'skip') reject(new Error('skipped by the operator'));
      };
    });
    try {
      return await Promise.race([until, timeout, skipped]);
    } finally {
      clearTimeout(timer);
      this.listener = null;
    }
  }
}

/** Waits `ms` while showing a countdown on one line. */
export async function countdown(label: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = Math.ceil((end - Date.now()) / 1000);
    const m = Math.floor(left / 60);
    const s = left % 60;
    process.stdout.write(`\r${label}: ${String(m)}:${String(s).padStart(2, '0')} left   `);
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, end - Date.now()))));
  }
  process.stdout.write(`\r${label}: done${' '.repeat(20)}\n`);
}
