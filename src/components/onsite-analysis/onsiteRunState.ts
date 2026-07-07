export type OnsiteRunState = {
  isProcessing: boolean;
};

export type OnsiteRunEvent =
  | { type: 'send.accepted' }
  | { type: 'send.rejected' }
  | { type: 'abort.requested' }
  | { type: 'terminal' };

export const initialOnsiteRunState: OnsiteRunState = {
  isProcessing: false,
};

export function reduceOnsiteRunState(
  state: OnsiteRunState,
  event: OnsiteRunEvent,
): OnsiteRunState {
  switch (event.type) {
    case 'send.accepted':
      return { isProcessing: true };
    case 'send.rejected':
    case 'terminal':
      return { isProcessing: false };
    case 'abort.requested':
      return state;
    default:
      return state;
  }
}
