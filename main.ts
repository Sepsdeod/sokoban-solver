// Room-by-room push-optimal Sokoban solver, written for the make.fun bounty
// "Build the best Sokoban solver, 21 November 2026" (sokoban-solver-01-run-20261121).
//
// Idea: every level the generator draws is a 1-wide hallway with 1-4 rooms off
// it, each room holding 3-4 boxes, and a box pushed out of a room's door can
// never come back -- so a level's push optimum P* is the sum of its rooms'
// optima, and each room can be solved on its own. This program splits a level
// into its rooms, solves each room with a push-optimal breadth-first search
// (one edge per push, so the first solved state found is optimal), then
// stitches the rooms' walks together. The search prunes two deadlocks that can
// never be undone: boxes on dead squares (found by pulling a box back from the
// goals, ignoring the other boxes) and boxes frozen in a 2x2 block of walls
// and boxes. Everything is budgeted by work (state counts), never by the
// clock, so two runs on one set write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps, in a fixed order so every run behaves alike. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

/** A board: width, height, walls, goal squares, box squares (sorted), player. */
interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A shared work budget: states spent across the whole set, capped by count. */
interface Budget {
  spent: number;
  limit: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The live squares: those a box can be pulled back from onto some goal,
 * ignoring the other boxes. A box off a live square can never be solved, so
 * the search never puts one there. Found by reverse play from the goals: a
 * box on square y can be pulled onto live square x = y + d when the player
 * can stand at y - d, i.e. x - 2d is open floor.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d; // the square the box is pulled from
      const stand = y - d; // where the player stands to pull it
      if (wall[y] || wall[stand] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each connected part left
 * that holds a box is a room. Null when a box starts in the hallway, a goal
 * falls in no part, or a part's boxes and goals do not match.
 */
function splitRooms(board: Board, live: Uint8Array): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = board;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Whether the box just pushed onto `t` sits frozen in a 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(board: Board, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Flood the player's reachable region from `from` around walls and the boxes
 * in `occ`, stamping `seen` with `stamp`; returns the region's lowest square,
 * which names the region in a state's key.
 */
function floodRegion(board: Board, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD letters (first direction first on ties). */
function walkTo(board: Board, occ: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The push-optimal solution of `board`: {pushes, moves} (moves in LURD, an
 * upper letter marking a push), or null when the search gives up. A state is
 * the boxes' squares and the player's reachable region, named by its lowest
 * square; states are expanded in order of pushes made, so the first solved
 * state found is push-optimal. The search keeps at most `maxStates` states
 * and draws on the shared `budget`; both are counts of work, never the clock.
 */
function solvePushes(board: Board, maxStates: number, budget: Budget): { pushes: number; moves: string } | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(board);
  const startBoxes = board.boxes.slice().sort((a, b) => a - b);
  if (startBoxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);

  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in the order found: their boxes, the player's square after the
  // push that made them, and the push (box from, box to, direction) from the parent.
  const stateBoxes: number[][] = [startBoxes];
  const statePlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const keyOf = (bs: number[], low: number): string => `${low}:${bs.join(',')}`;
  const seenKeys = new Map<string, number>();
  for (const b of startBoxes) occ[b] = 1;
  seenKeys.set(keyOf(startBoxes, floodRegion(board, occ, board.player, mark, ++stamp, stack)), 0);
  for (const b of startBoxes) occ[b] = 0;

  let found = solved(startBoxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head]!;
    for (const b of boxes) occ[b] = 1;
    const reachStamp = ++stamp;
    floodRegion(board, occ, statePlayer[head]!, seen, reachStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < DIRS.length; di++) {
        const dir = DIRS[di]!;
        const d = dir.dy * w + dir.dx;
        const t = b + d;
        // The player must be able to stand behind the box, and the square
        // ahead must be open floor a box can ever reach a goal from.
        if (seen[b - d] !== reachStamp || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(board, occ, goal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          key = keyOf(next, floodRegion(board, occ, b, mark, ++stamp, stack));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || next === null || seenKeys.has(key)) continue;
        if (stateBoxes.length >= maxStates || budget.spent >= budget.limit) {
          for (const x of boxes) occ[x] = 0;
          return null;
        }
        budget.spent++;
        seenKeys.set(key, stateBoxes.length);
        stateBoxes.push(next);
        statePlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(di);
        if (solved(next)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;

  // The pushes, root first, then the moves: walk to each push's square, push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = board.player;
  let boxes = startBoxes;
  for (const s of chain) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const di = pushDir[s]!;
    const dir = DIRS[di]!;
    const d = dir.dy * w + dir.dx;
    for (const b of boxes) occ[b] = 1;
    moves += walkTo(board, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += dir.push;
    player = from;
    const at = boxes.indexOf(from);
    boxes = boxes.slice();
    boxes[at] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: chain.length, moves };
}

/** Play `moves` on `board`, returning the boxes and player it leaves (throws on an illegal step). */
function applyMoves(board: Board, moves: string): { boxes: number[]; player: number } {
  const { w, wall } = board;
  const occ = new Uint8Array(wall.length);
  for (const b of board.boxes) occ[b] = 1;
  let boxes = board.boxes.slice();
  let player = board.player;
  for (const ch of moves.toLowerCase()) {
    const dir = DIRS.find((x) => x.step === ch);
    if (!dir) throw new Error(`applyMoves: bad step ${ch}`);
    const d = dir.dy * w + dir.dx;
    const q = player + d;
    if (wall[q]) throw new Error('applyMoves: step into a wall');
    const at = boxes.indexOf(q);
    if (at >= 0) {
      const t = q + d;
      if (wall[t] || occ[t]) throw new Error('applyMoves: push into a wall or a box');
      occ[q] = 0;
      occ[t] = 1;
      boxes = boxes.slice();
      boxes[at] = t;
      boxes.sort((a, b) => a - b);
    }
    player = q;
  }
  return { boxes, player };
}

/**
 * Solve one level's text, in as few pushes as the search can find: room by
 * room when the level splits cleanly, else one search over the whole level.
 * Always returns a string (empty when nothing was found, which still answers
 * the instance in the stated format).
 */
function solveLevel(text: string, budget: Budget): string {
  const level = parseLevel(text);
  const goal = new Uint8Array(level.w * level.h);
  for (const g of level.goals) goal[g] = 1;
  if (level.boxes.every((b) => goal[b])) return '';

  const live = liveSquares(level);
  const rooms = splitRooms(level, live);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    let boxes = level.boxes.slice();
    // Each room's boxes as they stand now (a solved room's boxes sit on its goals).
    const roomBoxes: number[][] = rooms.map((r) => r.boxes.slice());
    let ok = true;
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let oi = 0; oi < rooms.length; oi++) {
        if (oi === ri) continue;
        for (const b of roomBoxes[oi]!) wall[b] = 1;
      }
      const sub: Board = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, 250_000, budget);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      try {
        const after = applyMoves({ ...level, boxes, player }, solved.moves);
        boxes = after.boxes;
        player = after.player;
        roomBoxes[ri] = room.goals.slice().sort((a, b) => a - b);
      } catch {
        ok = false;
        break;
      }
    }
    if (ok && boxes.every((b) => goal[b])) return moves;
  }

  // Fallback: one search over the whole level, with a bigger state cap.
  const whole = solvePushes(level, 600_000, budget);
  if (whole !== null) {
    try {
      const after = applyMoves(level, whole.moves);
      if (after.boxes.every((b) => goal[b])) return whole.moves;
    } catch {
      // fall through to the empty answer
    }
  }
  return '';
}

const budget: Budget = { spent: 0, limit: 4_000_000 };
for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
