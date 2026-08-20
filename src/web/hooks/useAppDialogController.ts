import { useCallback, useRef, useState } from 'react';

export function useAppDialogController() {
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [showEditProjectModal, setShowEditProjectModal] = useState(false);
  const [showNewBoardModal, setShowNewBoardModal] = useState(false);
  const [showNewColumnModal, setShowNewColumnModal] = useState(false);
  const [showRegisterAgentModal, setShowRegisterAgentModal] = useState(false);
  const [showNewDocModal, setShowNewDocModal] = useState(false);
  const [showUserAccountModal, setShowUserAccountModal] = useState(false);
  const [userAccountInitialTab, setUserAccountInitialTab] = useState<
    'appearance' | 'tokens' | 'admin' | 'profile'
  >('appearance');
  const [showShortcutsHelpModal, setShowShortcutsHelpModal] = useState(false);
  const [newCardRequest, setNewCardRequest] = useState<{
    columnId?: string;
    token: number;
  } | null>(null);
  const [openCardRequest, setOpenCardRequest] = useState<{
    cardId: string;
    token: number;
  } | null>(null);
  const newCardTokenRef = useRef(0);
  const openCardTokenRef = useRef(0);

  const requestNewCard = useCallback((columnId?: string) => {
    newCardTokenRef.current += 1;
    setNewCardRequest({ columnId, token: newCardTokenRef.current });
  }, []);

  const requestOpenCard = useCallback((cardId: string) => {
    openCardTokenRef.current += 1;
    setOpenCardRequest({ cardId, token: openCardTokenRef.current });
  }, []);

  return {
    showNewProjectModal,
    setShowNewProjectModal,
    showEditProjectModal,
    setShowEditProjectModal,
    showNewBoardModal,
    setShowNewBoardModal,
    showNewColumnModal,
    setShowNewColumnModal,
    showRegisterAgentModal,
    setShowRegisterAgentModal,
    showNewDocModal,
    setShowNewDocModal,
    showUserAccountModal,
    setShowUserAccountModal,
    userAccountInitialTab,
    setUserAccountInitialTab,
    showShortcutsHelpModal,
    setShowShortcutsHelpModal,
    newCardRequest,
    setNewCardRequest,
    openCardRequest,
    setOpenCardRequest,
    requestNewCard,
    requestOpenCard,
  };
}
