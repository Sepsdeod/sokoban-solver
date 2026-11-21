# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Sepsdeod/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Sepsdeod/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![Node](https://img.shields.io/badge/node-%3E%3D%2022.18-339933)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A room-by-room push-optimal Sokoban solver for the make.fun bounty
**sokoban-solver-01-run-20261121**. One run of `main.ts` answers all 5
instances of a set in as few pushes as possible — on the practice set and on
three freshly drawn sets it hits the push-optimal count P\* on every
instance (score 1,000,000), against the house baseline plain-astar's 200,000.

## How it works

Every level the generator draws is a 1-wide hallway with 1–4 rooms off it,
each holding 3–4 boxes, and a box pushed out of a room's door can never come
back — so a level's push optimum P\* is the sum of its rooms' optima, and
each room can be solved on its own.

1. **Split** — cut the dead squares of the player's row (the hallway: a box
   there reaches no goal) out of the floor; each connected part left that
   holds a box is a room.
2. **Solve each room push-optimally** — breadth-first search over pushes
   (one edge per push, so the first solved state found is optimal). A state
   is the boxes' squares plus the player's reachable region, named by its
   lowest square. The search prunes two deadlocks that can never be undone:
   boxes on dead squares (found by pulling a box back from the goals,
   ignoring the other boxes) and boxes frozen in a 2×2 block of walls and
   boxes.
3. **Stitch** — solve the rooms in scan order, treating the other rooms'
   boxes (on their goals once solved) as walls, walking the player on from
   where the last room left it. If a level does not split cleanly, one
   push-optimal search over the whole level is the fallback.

Everything is budgeted by work (state counts, never the wall clock), so two
runs on one set write the same bytes. The whole 5-instance practice set
solves in ~1.4 s, far inside the 60 s wall budget.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, stdlib only, no dependencies) reads
`<input>/<id>/level.txt` for `i001`–`i005` and writes
`<output>/<id>/solution.txt` — the player's moves in LURD, an upper letter
marking a push.

## Layout

- `main.ts` — the solver (parse, dead-square analysis, room split, push-BFS,
  stitching, fallback)
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=7nvvsk82&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
