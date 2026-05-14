# Items for the together-lobotomization pass

## 1. No-comments rule is leaking through

CC's pristine prompt enforces "default to no comments". The model still adds sloppy header comments, phase markers, ASCII section banners, redundant JSDoc. Either the pristine no-comments section isn't aggressive enough OR an override in `~/.tweakcc/lobotomized-claude-code/system-prompts/` weakened it. Investigate and strengthen.

## 2. Task-tracking guidance — trim not remove

The prompt section _"Use TaskCreate to plan and track work. Mark each task completed as soon as it's done; don't batch."_ stays, just trim it. Decide what to keep when we lobotomize together.

## 3. Overengineering — handled

`system-prompt-doing-tasks-no-gold-plating.md` strengthened to cover: ambiguity-asks, fallback-path invention, multi-user generalization, "while I'm here" additions, hypothetical-future flexibility. Applied.
