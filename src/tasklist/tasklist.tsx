import assert from "assert";
import React, {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  useReducer,
  useState,
  useEffect,
  SyntheticEvent,
  Fragment
} from "react";
// @ts-ignore
import { setRange } from "selection-ranges";
import * as ops from "./actions";
import { TAction } from "./actions";
import { getChildren } from "./actions-helpers";
import { Store, TTask, TTaskID, TSelection } from "./store";
import useStyles from "./styles";
import Task from "./task";
import { getSelection } from "./utils";

function tasksReducer(state: TTask[], action: TAction) {
  // @ts-ignore TODO type
  return ops[action.type](state, action);
}

function TaskList({ tasks, store }: { tasks: TTask[]; store: Store }) {
  const classes = useStyles({});
  const [list, dispatchList] = useReducer(tasksReducer, tasks);
  const rootTasks = list.filter((t: TTask) => !t.parent);

  // TODO generate the first empty record if length === 0
  assert(list[0].id);

  // FOCUS & SELECTION

  const [focusedID, setFocusedID] = useState<TTaskID>(list[0].id);
  const [selection, setSelection] = useState<TSelection>([0, 0]);
  let focusedNode: HTMLSpanElement | undefined;
  function setFocusedNode(node: HTMLSpanElement) {
    focusedNode = node;
  }
  let nodeRefs: { [id: string]: HTMLSpanElement } = {};
  function setNodeRef(id: TTaskID, node: HTMLSpanElement) {
    // TODO GC old nodes by comparing with `list`
    nodeRefs[id] = node;
  }

  // INITIALIZE

  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    store.addRev(list, list[0].id, selection);
    setInitialized(true);
  }

  // UNDO

  // counts the chars typed / deleted per task since the last undo snapshot
  const [charsSinceUndo, setCharsSinceUndo] = useState<number>(0);
  const [undoTimer, setUndoTimer] = useState<number | undefined>(undefined);
  const [duringUndo, setDuringUndo] = useState<boolean>(false);
  // manually set the contentEditable
  const [manualTaskTitle, setManualTaskTitle] = useState<{
    id: TTaskID;
    title: string;
  } | null>(null);

  // TYPING

  let selectionBeforeTyping: TSelection | null = null;
  let titleBeforeTyping: string | null = null;

  // HELPERS

  function getTaskByID(id: string): TTask {
    return list.find((task: TTask) => task.id === id);
  }

  function resetUndoCounters() {
    console.log("resetUndoCounters");
    setCharsSinceUndo(0);
    if (undoTimer !== undefined) {
      clearTimeout(undoTimer);
    }
    setUndoTimer(undefined);
  }

  function persistSelection(id: TTaskID, node: HTMLElement): TSelection {
    setFocusedID(id);
    const def: TSelection = [0, 0];
    if (!node.isContentEditable || duringUndo) {
      return def;
    }
    const selection = getSelection(node);
    if (selection !== undefined) {
      setSelection(selection);
      console.log("persistSelection", id, selection);
    }
    return selection || def;
  }

  // HANDLERS

  /**
   * Handles:
   * - tab
   * - arrow up / down
   * - backspace (beginning of a line)
   * - selection deletion (along with keyUp)
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    const id = getDataID(event);
    const task = getTaskByID(id);
    const target = event.target as HTMLElement;
    titleBeforeTyping = target.textContent || "";

    // always save text before performing other action
    function createRevision() {
      console.log("createRevision");
      dispatchList({
        type: "update",
        store,
        id,
        // @ts-ignore
        title: target.textContent || "",
        selection
      });
      resetUndoCounters();
    }

    const undoPressed =
      String.fromCharCode(event.keyCode).toLowerCase() === "z" &&
      !event.altKey &&
      !event.shiftKey &&
      event.metaKey;
    const redoPressed =
      String.fromCharCode(event.keyCode).toLowerCase() === "z" &&
      !event.altKey &&
      event.shiftKey &&
      event.metaKey;

    // SWITCH TASKS
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      const index = list.indexOf(task);
      let indexChanged;
      // navigate between tasks
      if (event.key === "ArrowDown") {
        // move down
        indexChanged = Math.min(index + 1, list.length - 1);
      } else {
        // move up
        indexChanged = Math.max(index - 1, 0);
      }
      setFocusedID(list[indexChanged].id);
      event.preventDefault();
      // reset undo bc of an action
      resetUndoCounters();
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
      // reset undo bc of an action
      resetUndoCounters();
    } else if (event.key === "Enter") {
      // NEWLINE

      // break a task into two (or start a new one)
      event.preventDefault();
      createRevision();
      dispatchList({
        type: "newline",
        id,
        store,
        selection,
        setFocusedID,
        setSelection
      });
      // reset undo bc of an action
      resetUndoCounters();
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
        setSelection
      });
      // reset undo bc of an action
      resetUndoCounters();
    }

    // UNDO REDO
    else if (undoPressed || redoPressed) {
      setDuringUndo(true);
      // reset undo to avoid a fake revision
      resetUndoCounters();
      event.preventDefault();
      if (undoPressed) {
        // always save the newest version (if changed)
        createRevision();
        dispatchList({
          type: "undo",
          store,
          setSelection,
          setFocusedID,
          setManualTaskTitle
        });
      } else {
        dispatchList({
          type: "redo",
          store,
          setSelection,
          setFocusedID,
          setManualTaskTitle
        });
      }
    }

    // DELETE SELECTION
    else if (selection[0] != selection[1]) {
      // memorize the selection to check if it has been deleted on keyUp
      selectionBeforeTyping = selection;
    }
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

    // TASK SWITCHING
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
        setUndoTimer(setTimeout(createRev, store.msPerUndo));
        function createRev() {
          console.log("undo timer");
          // get the newest version
          const title = nodeRefs[id].textContent || "";
          // save
          dispatchList({
            type: "update",
            id,
            title,
            store,
            selection
          });
          resetUndoCounters();
        }
      }
    }
  }

  function handleClick(event: MouseEvent<HTMLElement>) {
    const id = getDataID(event);
    const target = event.target as HTMLElement;

    // persist selection
    // hooks get updated in the next re-render, so take the newest selection
    const selection = persistSelection(id, target);

    // CHECKBOX
    if (target?.tagName?.toLowerCase() === "input") {
      const input = target as HTMLInputElement;
      // save changes (if any)
      dispatchList({
        type: "update",
        store,
        id,
        title: target.textContent || "",
        selection
      });
      // flip the checkbox
      dispatchList({
        type: "completed",
        id,
        completed: input.checked,
        store,
        selection
      });
    }

    // undo for switching tasks
    if (id !== focusedID) {
      store.addRev(list, id, selection);
    }
  }

  function handleBlur(event: FocusEvent<HTMLSpanElement>) {
    if (duringUndo) {
      console.log("skipping blur bc of duringUndo");
      return;
    }
    // only for content editable spans
    if (!event.target.isContentEditable) {
      return;
    }

    const id = getDataID(event);
    console.log("blur save");
    dispatchList({
      type: "update",
      store,
      id,
      title: event.target.textContent || "",
      selection: getSelection(event.target) ?? selection
    });
    resetUndoCounters();
  }

  // restore the focus and selection
  useEffect(() => {
    setDuringUndo(false);
    if (!focusedNode) {
      return;
    }
    // focus if not already
    if (focusedNode !== document.activeElement) {
      focusedNode.focus();
    }
    // restore the selection
    // console.log("restore caret", selection);
    setRange(focusedNode, { start: selection[0], end: selection[1] });
  });

  // manually update the contentEditable (for undo / redo)
  useEffect(() => {
    if (!manualTaskTitle) {
      return;
    }
    console.log("restore setTaskTitle", manualTaskTitle);
    nodeRefs[manualTaskTitle.id].textContent = manualTaskTitle.title;
    setManualTaskTitle(null);
  });

  return (
    <table
      className={classes.table}
      onMouseUp={handleClick}
      onKeyUp={handleKeyUp}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <tbody>
        {rootTasks.map((task: TTask) => {
          const children = [];
          for (const child of getChildren(task.id, list)) {
            children.push(
              <Task
                key={child.id}
                task={child}
                focusedID={focusedID}
                setFocusedNode={setFocusedNode}
                setNodeRef={setNodeRef}
              />
            );
          }
          return (
            <Fragment key={task.id}>
              <Task
                key={task.id}
                task={task}
                focusedID={focusedID}
                setFocusedNode={setFocusedNode}
                setNodeRef={setNodeRef}
              />
              {children}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
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

export default TaskList;