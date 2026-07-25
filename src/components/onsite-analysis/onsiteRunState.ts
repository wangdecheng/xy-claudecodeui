export type OnsiteRunState = {
  isProcessing: boolean;
  isStopping: boolean;
  startedAt: number | null;
};

export type OnsiteRunEvent =
  | { type: 'send.accepted'; startedAt: number }
  | { type: 'send.rejected' }
  | { type: 'abort.requested' }
  | { type: 'terminal' };

export const initialOnsiteRunState: OnsiteRunState = {
  isProcessing: false,
  isStopping: false,
  startedAt: null,
};

export function reduceOnsiteRunState(
  state: OnsiteRunState,
  event: OnsiteRunEvent,
): OnsiteRunState {
  switch (event.type) {
    case 'send.accepted':
      return {
        isProcessing: true,
        isStopping: false,
        startedAt: event.startedAt,
      };
    case 'send.rejected':
    case 'terminal':
      return initialOnsiteRunState;
    case 'abort.requested':
      return state.isProcessing ? { ...state, isStopping: true } : state;
    default:
      return state;
  }
}
