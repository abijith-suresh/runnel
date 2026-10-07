// Git hooks export repository paths. Child commands that select a repository by
// cwd must not inherit those paths or other Git overrides from the caller.
export function gitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  );
}
