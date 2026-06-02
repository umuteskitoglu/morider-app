// Module-level draft store for the start/end locations chosen while creating an
// event. Kept OUTSIDE React (and outside navigation params) so the two picks
// survive the EventCreate screen being detached/remounted as the user hops to
// the map picker and back — neither component state nor param merge is reliable
// across that transition. Reset when a fresh "new event" flow starts.

export type EventPoint = { lat: number; lon: number; name: string };

let startPoint: EventPoint | null = null;
let endPoint: EventPoint | null = null;

export const eventDraft = {
  get start(): EventPoint | null {
    return startPoint;
  },
  get end(): EventPoint | null {
    return endPoint;
  },
  setStart(p: EventPoint | null) {
    startPoint = p;
  },
  setEnd(p: EventPoint | null) {
    endPoint = p;
  },
  reset() {
    startPoint = null;
    endPoint = null;
  },
};
