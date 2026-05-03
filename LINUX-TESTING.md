# Linux Testing

Run these on the VPS:

```bash
cd ~/dev/tweakcc-fixed
git pull
npm install
npm run build
node dist/index.mjs apply
claude --version
node dist/index.mjs revert
```

Success looks like:

- `npm run build` exits cleanly and produces `dist/index.mjs` and `dist/lib/index.mjs`.
- `node dist/index.mjs apply` detects the Linux ELF `claude.exe`, applies the saved theme/customization patch, and exits without codesigning.
- `claude --version` still prints the Claude Code version after patching.
- `node dist/index.mjs revert` restores the backup cleanly.
