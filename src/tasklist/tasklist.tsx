import assert from "assert";
import debug from "debug";
import React, {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  useReducer,
  useState,
  useEffect,
  SyntheticEvent,
  Fragment,
} from "react";
import { useBeforeunload } from "react-beforeunload";
// @ts-ignore
import { setRange } from "selection-ranges";
import Form from "../form/form";
import Toolbar from "../toolbar/toolbar";
import { reducer } from "./actions";
import {
  getChildren,
  createTask,
  TSelection,
  TTask,
  TTaskID,
  getRootTasks,
} from "./model";
import { Store } from "./store";
import useStyles from "./styles";
import Task from "./task";
import {
  getSelection,
  isMacOS,
  ctrlMetaPressed,
  flipSelectionBackwards,
} from "./utils";

const log = debug("canvas");

export default function ({ tasks, store }: { tasks: TTask[]; store: Store }) {
  const classes = useStyles({});
  const [list, dispatchList] = useReducer(reducer, tasks);
  const rootTasks = getRootTasks(list);

  // there always at least one task
  if (!list.length) {
    list.push(createTask());
  }

  // FOCUS & SELECTION

  // lock the UI so persisted state cant be different then UIs one
  const [uiLock, setUILock] = useState<boolean>(false);
  const [focusedID, setFocusedIDInternal] = useState<TTaskID>(list[0].id);
  function setFocusedID(id: TTaskID) {
    resetUndoCounters();
    setFocusedIDInternal(id);
  }
  const [selection, setSelection] = useState<TSelection>([0, 0, false]);
  const [nodeRefs] = useState<{ [id: string]: HTMLSpanElement }>({});
  function setNodeRef(id: TTaskID, node: HTMLSpanElement) {
    // TODO GC old nodes by comparing with `list`
    // avoid the hook setter, as re-rendering isnt needed here
    nodeRefs[id] = node;
  }

  // INITIALIZE

  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    store.set(list, list[0].id, selection);
    setInitialized(true);
  }

  // UNDO

  // counts the chars typed / deleted per task since the last undo snapshot
  const [charsSinceUndo, setCharsSinceUndo] = useState<number>(0);
  const [undoTimer, setUndoTimer] = useState<number | undefined>(undefined);
  // current render is triggered by undo / redo
  const [duringUndo, setDuringUndo] = useState<boolean>(false);
  // manually set the contentEditable
  const [manualTaskTitle, setManualTaskTitle] = useState<{
    id: TTaskID;
    title: string;
  } | null>(null);

  // TYPING

  let selectionBeforeTyping: TSelection | null = null;
  let titleBeforeTyping: string | null = null;

  // TOP NAV BAR OPTIONS

  const [showDeleted, setShowDeleted] = useState<boolean>(false);
  const [showCompleted, setShowCompleted] = useState<boolean>(false);

  // PERSIST ON PAGE UNLOAD
  // TODO doesnt work with refresh

  useBeforeunload(() => {
    const node = nodeRefs[focusedID];
    if (!node) {
      return;
    }
    dispatchList({
      type: "update",
      store,
      id: focusedID,
      title: node.textContent || "",
      selection,
    });
  });

  // DIALOG
  const [formVisible, setFormVisible] = useState<TTaskID | null>(null);

  // HELPERS

  function getTaskByID(id: string): TTask {
    const task = list.find((task: TTask) => task.id === id);
    assert(task, `task ${id} not found`);
    return task!;
  }

  function resetUndoCounters() {
    log("resetUndoCounters");
    setCharsSinceUndo(0);
    if (undoTimer !== undefined) {
      clearTimeout(undoTimer);
    }
    setUndoTimer(undefined);
  }

  function persistSelection(id: TTaskID, node: HTMLElement): TSelection {
    setFocusedID(id);
    const def: TSelection = [0, 0, false];
    if (!node.isContentEditable || duringUndo) {
      return def;
    }
    const selection = getSelection(node);
    if (selection !== undefined) {
      setSelection(selection);
      log("persistSelection", id, selection);
    }
    return selection || def;
  }

  function isTaskVisible(task: TTask): boolean {
    return Boolean(!task.hidden || showCompleted);
  }

  function visibleTasks(): TTask[] {
    return list.filter(isTaskVisible);
  }

  // HANDLERS

  /**
   * Handles:
   * - indent (Tab)
   * - navigate (arrow up / down)
   * - move (META + arrow up / down)
   * - merge prev line (Backspace)
   * - selection deletion (along with keyUp)
   * - edit form (shift + enter)
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (uiLock) {
      event.preventDefault();
      return;
    }
    const id = getDataID(event);
    const task = getTaskByID(id);
    const target = event.target as HTMLElement;
    titleBeforeTyping = target.textContent || "";

    // always save text before performing another action
    function createRevision() {
      log("createRevision");
      dispatchList({
        type: "update",
        store,
        id,
        title: target.textContent || "",
        selection,
      });
      resetUndoCounters();
    }

    const undoPressed =
      String.fromCharCode(event.keyCode).toLowerCase() === "z" &&
      !event.altKey &&
      !event.shiftKey &&
      ctrlMetaPressed(event);
    const redoPressed =
      String.fromCharCode(event.keyCode).toLowerCase() === "z" &&
      !event.altKey &&
      event.shiftKey &&
      ctrlMetaPressed(event);

    // SWITCH THE FOCUSED TASKS
    if (["ArrowDown", "ArrowUp"].includes(event.key) && !isModifierKey(event)) {
      const listVisible = visibleTasks();
      const index = listVisible.indexOf(task);
      let newIndex;
      // navigate between tasks
      // TODO between visible ones only
      if (event.key === "ArrowDown") {
        // move down
        newIndex = Math.min(index + 1, listVisible.length - 1);
      } else {
        // move up
        newIndex = Math.max(index - 1, 0);
      }
      const id = listVisible[newIndex].id;
      if (focusedID !== id) {
        // collapse the selection
        setSelection([selection[1], selection[1], false]);
        setFocusedID(listVisible[newIndex].id);
      }
      event.preventDefault();
    }

    // MOVE TASKS ON THE LIST
    else if (
      ["ArrowDown", "ArrowUp"].includes(event.key) &&
      isModifierKey(event)
    ) {
      if (event.key === "ArrowUp") {
        dispatchList({ type: "moveUp", id, store, selection: selection });
      } else {
        dispatchList({ type: "moveDown", id, store, selection: selection });
      }
    }

    // EDIT FORM
    else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      setFormVisible(focusedID);
    }

    // INDENT OUTDENT
    else if (event.key === "Tab") {
      event.preventDefault();
      createRevision();
      if (event.shiftKey) {
        dispatchList({ type: "outdent", id, store, selection: selection });
      } else {
        dispatchList({ type: "indent", id, store, selection: selection });
      }
    }

    // NEWLINE
    else if (event.key === "Enter") {
      // break a task into two (or start a new one)
      event.preventDefault();
      createRevision();
      dispatchList({
        type: "newline",
        id,
        store,
        selection,
        setFocusedID,
        setSelection,
      });
    }

    // MERGE
    else if (
      event.key === "Backspace" &&
      target.isContentEditable &&
      selection[0] === 0 &&
      selection[1] === 0
    ) {
      // merge with the task above
      event.preventDefault();
      dispatchList({
        type: "mergePrevLine",
        id,
        selection,
        store,
        setFocusedID,
        setSelection,
      });
      // reset undo bc of an action
      resetUndoCounters();
    }

    // UNDO REDO
    else if (undoPressed || redoPressed) {
      setDuringUndo(true);
      event.preventDefault();
      if (undoPressed) {
        // always save the newest version (if changed)
        createRevision();
        dispatchList({
          type: "undo",
          store,
          setSelection,
          setFocusedID,
          setManualTaskTitle,
        });
      } else {
        // reset undo to avoid a fake revision
        resetUndoCounters();
        dispatchList({
          type: "redo",
          store,
          setSelection,
          setFocusedID,
          setManualTaskTitle,
        });
      }
    }

    // DELETE SELECTION
    else if (selection[0] != selection[1]) {
      // memorize the selection to check if it has been deleted on keyUp
      selectionBeforeTyping = selection;
    }
  }

  function isModifierKey(event: KeyboardEvent) {
    return isMacOS() ? event.metaKey : event.ctrlKey;
  }

  /**
   * Handles:
   * - typing
   * - task switching with arrows
   * - selection deletion
   */
  function handleKeyUp(event: KeyboardEvent<HTMLElement>) {
    const id = getDataID(event);
    const target = event.target as HTMLElement;

    if (!target.isContentEditable) {
      return;
    }

    // CARET NAVIGATION
    if (["ArrowRight", "ArrowLeft"].includes(event.key)) {
      persistSelection(id, target);
      return;
    }

    // TYPING ON A SELECTION
    const title = target.textContent || "";
    if (selectionBeforeTyping && title !== titleBeforeTyping) {
      const selection = persistSelection(id, target);

      dispatchList({ type: "update", id, title, store, selection });
    }
    // TYPING
    else if (!selectionBeforeTyping && title !== titleBeforeTyping) {
      const selection = persistSelection(id, target);

      // increase the chars counter
      setCharsSinceUndo(charsSinceUndo + 1);

      if (charsSinceUndo >= store.charsPerUndo) {
        // create a revision after an X amount of modifications
        dispatchList({ type: "update", id, title, store, selection });
        resetUndoCounters();
      } else if (undoTimer === undefined) {
        // handle a time-based revision
        setUndoTimer(setTimeout(createUndoRev, store.msPerUndo));
        function createUndoRev() {
          setUILock(true);
          log("undo timer");
          // get the newest version
          const title = nodeRefs[id].textContent || "";
          // save
          dispatchList({
            type: "update",
            id,
            title,
            store,
            selection,
          });
          resetUndoCounters();
          setUILock(false);
        }
      }
    }
  }

  function handleClick(event: MouseEvent<HTMLElement>) {
    log("clicked");
    const id = getDataID(event);
    const target = event.target as HTMLElement;

    // persist the selection
    // hooks get updated in the next re-render, so take the newest selection
    const selection = persistSelection(id, target);

    // CHECKBOX
    if (isCheckbox(target, event.currentTarget)) {
      const input = target as HTMLInputElement;
      // save changes (if any) using a refNode
      // TODO save from the focused task, not from the clicked one
      if (nodeRefs[id]) {
        dispatchList({
          type: "update",
          store,
          id,
          title: nodeRefs[id].textContent || "",
          selection,
        });
      }
      // flip the checkbox
      dispatchList({
        type: "update",
        id,
        completed: !input.checked,
        store,
        selection,
      });
      event.preventDefault();
    }

    // undo for switching tasks
    if (id !== focusedID) {
      store.addRev(list, id, selection);
    }
  }

  function handleBlur(event: FocusEvent<HTMLSpanElement>) {
    if (duringUndo) {
      log("skipping blur bc of duringUndo");
      return;
    }
    // only for content editable spans
    if (!event.target.isContentEditable) {
      return;
    }

    const id = getDataID(event);
    const preBlurSelection = getSelection(event.target) ?? selection;
    const title = event.target.textContent || "";
    dispatchList({
      type: "update",
      store,
      id,
      title,
      selection: preBlurSelection,
    });
  }

  function handleForm(task: TTask) {
    setFormVisible(null);
    dispatchList({
      type: "update",
      store,
      id: focusedID,
      title: task.title || "",
      content: task.content || "",
      duedate: task.duedate || undefined,
      completed: task.completed,
      selection,
    });
  }

  // EFFECTS

  // restore the focus and selection
  useEffect(() => {
    const focusedNode = nodeRefs[focusedID];
    if (!focusedNode) {
      return;
    }
    // force focus if needed
    if (focusedNode !== document.activeElement) {
      log("forcing focus");
      focusedNode.focus();
    }

    if (!duringUndo) {
      // restore the selection only when undoing
      return;
    }
    setDuringUndo(false);
    const currentSelection = getSelection(focusedNode);
    if (
      currentSelection &&
      currentSelection[0] === selection[0] &&
      currentSelection[1] === selection[1]
    ) {
      // restore the selection only if not currently set
      return;
    }
    setRange(focusedNode, { start: selection[0], end: selection[1] });
    if (selection[2]) {
      flipSelectionBackwards();
    }
    log("restored the selection", selection);
  });

  // manually update the contentEditable (for undo / redo)
  useEffect(() => {
    if (!manualTaskTitle) {
      return;
    }
    log("restore setTaskTitle", manualTaskTitle);
    nodeRefs[manualTaskTitle.id].textContent = manualTaskTitle.title;
    setManualTaskTitle(null);
  });

  return (
    <Fragment>
      <Toolbar
        dispatchList={dispatchList}
        id={focusedID}
        selection={selection}
        setFormVisible={setFormVisible}
        showCompleted={showCompleted}
        setShowCompleted={setShowCompleted}
        showDeleted={showDeleted}
        setShowDeleted={setShowDeleted}
        store={store}
        setFocusedID={setFocusedID}
        setSelection={setSelection}
      />
      <table
        style={formVisible ? { display: "none" } : {}}
        className={classes.table}
        onMouseUp={handleClick}
        onKeyUp={handleKeyUp}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      >
        <tbody>
          {rootTasks.map((task: TTask) => {
            if (!isTaskVisible(task)) {
              return;
            }
            // children
            const children = [];
            for (const child of getChildren(task.id, list)) {
              if (!isTaskVisible(child)) {
                continue;
              }
              children.push(
                <Task
                  key={child.id}
                  task={child}
                  focusedID={focusedID}
                  setNodeRef={setNodeRef}
                  setFormVisible={setFormVisible}
                />
              );
            }
            return (
              <Fragment key={task.id}>
                <Task
                  key={task.id}
                  task={task}
                  focusedID={focusedID}
                  setNodeRef={setNodeRef}
                  setFormVisible={setFormVisible}
                />
                {children}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {formVisible && (
        <Form task={getTaskByID(formVisible)} handleSubmit={handleForm} />
      )}
    </Fragment>
  );
}

// used to identify a (delegated) click on one-of-many-and-all nodes
// composing a material-ui checkbox
function isCheckbox(target: HTMLElement, root: HTMLElement): boolean {
  if (target?.tagName?.toLowerCase() === "input") {
    return true;
  }

  let node = target;
  do {
    if (node?.tagName?.toLowerCase() === "input") {
      return true;
    } else if (node?.dataset.checkbox) {
      return true;
    }
    node = node?.parentElement || target;
  } while (node && node !== root);

  return false;
}

/**
 * Returns the task ID from the event.
 */
function getDataID(event: SyntheticEvent<Node>): TTaskID {
  let node = event.target as Node | null;
  while (node) {
    // @ts-ignore
    if (node.dataset?.id) {
      // @ts-ignore
      return node.dataset.id;
    }
    node = node.parentNode;
  }
  throw new Error("missing [data-id]");
}
