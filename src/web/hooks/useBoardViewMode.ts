import { useCallback, useState } from 'react';

export type BoardViewMode = 'default' | 'swimlanes';

export function useBoardViewMode(): [BoardViewMode, (mode: BoardViewMode) => void] {
  const [mode, setModeState] = useState<BoardViewMode>(() => {
    try {
      return localStorage.getItem('muster_board_view_mode') === 'swimlanes' ? 'swimlanes' : 'default';
    } catch {
      return 'default';
    }
  });

  const setMode = useCallback((nextMode: BoardViewMode) => {
    setModeState(nextMode);
    try {
      localStorage.setItem('muster_board_view_mode', nextMode);
    } catch (error) {
      console.error('Failed to save board view mode preference:', error);
    }
  }, []);

  return [mode, setMode];
}
