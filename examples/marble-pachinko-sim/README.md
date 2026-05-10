# Marble Pachinko Clash

A local-first 2D physics prototype for a two-team marble pachinko simulator.

- Blue team starts on the left and has gravity pulling right.
- Red team starts on the right and has gravity pulling left.
- The field is generated on the left half, then mirrored onto the right half for symmetric team lanes.
- The board now has clear side staging pockets and opposite-side goal zones.
- Marbles score only when their leading edge touches the back edge of the opposite side, then respawn with the same unique team asset.
- Goal lanes are worth 1/2/3/2/1 points from top to bottom, with the 3-point zone centered.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

## Current prototype knobs

Edit `src/main.tsx` to quickly change:

- `spawnTeam(..., 26)` marble counts
- `SIDE_ZONE` / `GOAL_ZONE` visual layout widths
- sideways gravity strength around `360`
- mirrored field rows/columns in `newField()`
- peg and triangle generation rates/sizes
- scoring and respawn behavior

## Next design questions

- Are teams racing for total score, territory control, survival, or elimination?
- Should marbles have individual traits/classes?
- Should mirrored collider fields be seeded for replayable matchups?
- Should the player influence the board, the marbles, or just watch/simulate?
