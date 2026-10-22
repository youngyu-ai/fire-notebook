/**
 * 消防小本本
 * GAS server-side application.
 *
 * Setup:
 * 1. Set ROOT_FOLDER_ID to the Drive parent folder ID.
 * 2. Enable the Google Tasks advanced service.
 * 3. Run setupSystem() once from the Apps Script editor and authorize it.
 */

const ROOT_FOLDER_ID = "YOUR_FOLDER_ID";
const DEFAULT_ACCESS_PASSCODE = "119"; // GitHub Pages PWA 預設通行密碼（首次登入後也可於網頁內或指令碼屬性 ACCESS_PASSCODE 修改）
const SPREADSHEET_ID = ""; // Optional. Leave blank to create a spreadsheet on first setup.
const DATA_SHEET_NAME = "業務公文管理";
const INDEX_SHEET_NAME = "_系統索引";
const TASK_LIST_TITLE = "消防";
const TIME_ZONE = "Asia/Taipei";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // Raw bytes; the 6 MiB serialized request cap is stricter for Base64.
const MAX_REQUEST_JSON_BYTES = 6 * 1024 * 1024;
const REQUEST_CACHE_TTL_SECONDS = 600;
const OPERATION_RETENTION_DAYS = 7;
const MAX_OPERATION_ROWS = 1000;
const OPERATION_SHEET_NAME = "_操作紀錄";
const TASK_COUNT_CACHE_TTL_SECONDS = 60;
const MAX_HISTORY_CHARS = 50000; // Google Sheets cell content limit.
const BACKUP_FOLDER_NAME = "_系統備份";
const MAX_BACKUP_FILES = 24;
const RECORD_PAGE_SIZE = 60;
const TASK_PAGE_SIZE = 50;
const METADATA_CACHE_CHUNK_SIZE = 32;
const METADATA_CACHE_TTL_SECONDS = 60;
const OPERATION_HEADERS = ["clientRequestId", "operation", "state", "stage", "payloadFingerprint", "資料ID", "列號", "資料夾ID", "resultJson", "更新時間"];
const DATA_HEADERS = [
  "資料ID", "發文/登記日期", "標籤類別", "案件/公文主旨", "內容說明",
  "限辦/完成期限", "執行狀態", "執行進度與摘要", "專屬資料夾連結", "建檔時間"
];
const INDEX_HEADERS = ["資料ID", "列號", "資料夾ID", "Tasks清單ID", "Tasks任務ID", "更新時間"];
const VALID_STATUSES = ["待辦", "辦理中", "已結案", "存查"];

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("消防小本本")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover")
    .addMetaTag("apple-mobile-web-app-capable", "yes")
    .addMetaTag("mobile-web-app-capable", "yes");
}

/**
 * GitHub Pages PWA 跨網域 JSON API 入口（附帶裝置通行密碼驗證）
 */
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    if (raw.length > MAX_REQUEST_JSON_BYTES) {
      return jsonApiResponse_({ ok: false, error: "請求資料量超過上限（6 MiB），請減少單次上傳附件。" });
    }
    const body = JSON.parse(raw);
    const action = String(body.action || "").trim();
    const passcode = String(body.passcode == null ? "" : body.passcode).trim();
    const args = Array.isArray(body.args) ? body.args : [];

    if (!verifyAccessPasscode_(passcode)) {
      return jsonApiResponse_({
        ok: false,
        authError: true,
        error: "通行密碼不正確或尚未設定信任裝置，請輸入正確通行密碼。"
      });
    }

    if (action === "apiVerifyPasscode") {
      return jsonApiResponse_({ ok: true, result: { trusted: true } });
    }
    if (action === "apiChangePasscode") {
      return jsonApiResponse_({ ok: true, result: apiChangePasscode(args[0], args[1]) });
    }

    const handlers = {
      apiBootstrap: apiBootstrap,
      apiLoadActivePage: apiLoadActivePage,
      apiLoadArchiveYear: apiLoadArchiveYear,
      apiGetRecordHistory: apiGetRecordHistory,
      apiCreateRecord: apiCreateRecord,
      apiUpdateRecord: apiUpdateRecord,
      apiLoadTasks: apiLoadTasks,
      apiAddQuickTask: apiAddQuickTask,
      apiToggleTask: apiToggleTask,
      apiDeleteTask: apiDeleteTask,
      apiSyncRecordToTask: apiSyncRecordToTask
    };

    if (!Object.prototype.hasOwnProperty.call(handlers, action)) {
      return jsonApiResponse_({ ok: false, error: "未知的 API 操作：" + action });
    }

    const result = handlers[action].apply(null, args);
    return jsonApiResponse_({ ok: true, result: result });
  } catch (err) {
    return jsonApiResponse_({ ok: false, error: errorMessage_(err) });
  }
}

function jsonApiResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getExpectedPasscode_() {
  const propPass = PropertiesService.getScriptProperties().getProperty("ACCESS_PASSCODE");
  return String(propPass && propPass.trim() ? propPass : DEFAULT_ACCESS_PASSCODE).trim();
}

function verifyAccessPasscode_(inputPasscode) {
  const expected = getExpectedPasscode_();
  if (!expected) return true;
  return String(inputPasscode || "").trim() === expected;
}

function apiChangePasscode(currentPasscode, newPasscode) {
  if (!verifyAccessPasscode_(currentPasscode)) {
    throw new Error("目前通行密碼不正確。");
  }
  const cleanNew = String(newPasscode || "").trim();
  if (cleanNew.length < 3) {
    throw new Error("新通行密碼長度請至少 3 個字元。");
  }
  PropertiesService.getScriptProperties().setProperty("ACCESS_PASSCODE", cleanNew);
  return { updated: true };
}

/**
 * Run once in the Apps Script editor. Creates the workbook/index, checks Drive,
 * locates or creates the personal Tasks list, and installs monthly backups.
 */
function setupSystem() {
  const root = getRootFolder_();
  const ss = getSpreadsheet_();
  const dataSheet = getDataSheet_(ss);
  const indexSheet = getIndexSheet_(ss);
  getOperationSheet_(ss);
  const tasksList = ensureTasksList_();
  ensureBackupFolder_(root);
  installMonthlyBackupTrigger_();
  installOperationCleanupTrigger_();
  let metadataTriggerWarning = "";
  try {
    installMetadataInvalidationTriggers_(ss);
  } catch (triggerError) {
    // This is an optimization. Metadata cache expiry remains the fallback.
    metadataTriggerWarning = "試算表快取失效觸發器未完整安裝；直接編輯的快取可能延遲最多 60 秒更新。原因：" + errorMessage_(triggerError);
  }
  return {
    spreadsheetUrl: ss.getUrl(),
    dataSheetName: dataSheet.getName(),
    indexSheetName: indexSheet.getName(),
    operationSheetName: OPERATION_SHEET_NAME,
    taskListTitle: tasksList.title,
    rootFolderUrl: root.getUrl(),
    backupFolderName: BACKUP_FOLDER_NAME,
    metadataTriggerWarning: metadataTriggerWarning
  };
}

function apiBootstrap() {
  const ss = getSpreadsheet_();
  getDataSheet_(ss);
  getIndexSheet_(ss);
  const metadata = readMetadata_();
  const rows = metadata.records;
  const cutoff = dateString_(new Date()).slice(0, 4) + "-01-01";
  const active = rows.filter(function (r) {
    return r.status === "待辦" || r.status === "辦理中" || (r.date && r.date >= cutoff);
  });
  const page = pageRecords_(active, "");
  const years = archiveYearsFromMetadata_(rows, cutoff);
  let rootUrl = "";
  try {
    rootUrl = getRootFolder_().getUrl();
  } catch (err) {
    rootUrl = "";
  }
  return {
    records: hydrateRecords_(page.records, false, metadata.rowById),
    activeCursor: page.cursor,
    activeHasMore: page.hasMore,
    archiveYears: years,
    spreadsheetUrl: ss.getUrl(),
    rootFolderUrl: rootUrl,
    uploadLimitBytes: MAX_UPLOAD_BYTES,
    maxRequestJsonBytes: MAX_REQUEST_JSON_BYTES,
    timeZone: TIME_ZONE
  };
}

function apiLoadActivePage(cursor) {
  const cutoff = dateString_(new Date()).slice(0, 4) + "-01-01";
  const metadata = readMetadata_();
  const active = metadata.records.filter(function (r) {
    return r.status === "待辦" || r.status === "辦理中" || (r.date && r.date >= cutoff);
  });
  const page = pageRecords_(active, cursor);
  return {
    records: hydrateRecords_(page.records, false, metadata.rowById),
    cursor: page.cursor,
    hasMore: page.hasMore
  };
}

function apiLoadArchiveYear(year, cursor) {
  const yearText = String(year || "");
  if (!/^\d{4}$/.test(yearText)) throw new Error("年度格式不正確。");
  const metadata = readMetadata_();
  const matches = metadata.records.filter(function (r) {
    return r.date && r.date.slice(0, 4) === yearText;
  });
  const page = pageRecords_(matches, cursor);
  return {
    records: hydrateRecords_(page.records, false, metadata.rowById),
    cursor: page.cursor,
    hasMore: page.hasMore
  };
}

function apiGetRecordHistory(id, rowIndex) {
  const sheet = getDataSheet_(getSpreadsheet_());
  const resolvedRow = resolveRowIndex_(sheet, String(id), Number(rowIndex));
  const record = recordObject_(resolvedRow, sheet.getRange(resolvedRow, 1, 1, DATA_HEADERS.length).getValues()[0]);
  return {
    id: String(id),
    history: record.history || "",
    description: record.description || ""
  };
}

function apiCreateRecord(payload) {
  payload = payload || {};
  assertPayloadSize_(payload);
  const requestId = requiredText_(payload.clientRequestId, "clientRequestId", 100);
  const date = normalizeDate_(payload.date, true);
  const category = requiredText_(payload.category, "標籤類別", 100);
  const subject = requiredText_(payload.subject, "案件/公文主旨", 500);
  const description = optionalText_(payload.description, 20000);
  const dueDate = normalizeDate_(payload.dueDate, false);
  const status = normalizeStatus_(payload.status || "待辦");
  const files = normalizeFiles_(payload.files);
  const fingerprint = payloadFingerprint_(payload);
  const reservation = beginOperation_(requestId, "CREATE", fingerprint);
  if (reservation.state === "DONE") return reservation.result;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let folder = null;
  let uploaded = [];
  let rowWritten = false;
  let result;
  try {
    const op = readOperationRow_(reservation.row);
    if (op.state === "DONE" && op.result) return op.result;
    if (!reservation.isNew) {
      const sheet = getDataSheet_(getSpreadsheet_());
      const recoveredRow = op.recordId ? findDataRowById_(sheet, op.recordId) : 0;
      if (!recoveredRow) {
        throw new Error("這筆建檔曾開始但尚未完成。系統已保留請求 ID，為避免重複建立，請先重新載入案件清單並確認是否已有資料，再依部署指南的「操作紀錄修復」處理。");
      }
      const values = sheet.getRange(recoveredRow, 1, 1, DATA_HEADERS.length).getValues()[0];
      const record = recordObject_(recoveredRow, values);
      const recoveredIndex = findIndexEntry_(getIndexSheet_(getSpreadsheet_()), record.id);
      if (recoveredIndex && recoveredIndex.taskId) record.taskId = recoveredIndex.taskId;
      rowWritten = true;
      let taskWarning = "";
      try {
        upsertIndex_(getIndexSheet_(getSpreadsheet_()), {
          id: record.id, rowIndex: recoveredRow,
          folderId: recoveredIndex && recoveredIndex.folderId ? recoveredIndex.folderId : folderIdFromUrl_(record.folderUrl),
          taskListId: recoveredIndex ? recoveredIndex.taskListId : "",
          taskId: recoveredIndex ? recoveredIndex.taskId : ""
        });
        if (payload.addToTasks !== false) {
          const task = syncRecordTask_(record, false, true, true);
          record.taskId = task.id;
          record.taskUrl = task.webViewLink || "";
        }
      } catch (err) {
        taskWarning = "案件已建立；索引或 Tasks 補同步失敗：" + errorMessage_(err);
      }
      result = { record: recordCardObject_(record), taskWarning: taskWarning };
      finishOperation_(reservation.row, requestId, "CREATE", result, {
        recordId: record.id, rowIndex: recoveredRow,
        folderId: folderIdFromUrl_(record.folderUrl)
      });
      return result;
    }

    const ss = getSpreadsheet_();
    const sheet = getDataSheet_(ss);
    const indexSheet = getIndexSheet_(ss);
    const now = new Date();
    const id = generateDocumentId_(sheet, now);
    setOperationFields_(reservation.row, {
      state: "PENDING", stage: "ID_RESERVED", recordId: id
    });

    folder = createCaseFolder_(category, date, subject, id, requestId);
    setOperationFields_(reservation.row, {
      stage: "FOLDER_READY", folderId: folder.getId()
    });

    const timestamp = formatDateTime_(now);
    const uploadPlan = prepareUploadNames_(folder, files, "original", now, requestId);
    const expectedFiles = uploadPlan.names.map(function (name) { return { name: name }; });
    const history = makeInitialHistory_(timestamp, status, expectedFiles);
    ensureHistoryFits_(history);
    uploaded = [];
    saveFiles_(folder, files, "original", now, requestId, function (file) {
      uploaded.push(file);
    }, uploadPlan);

    const existingRow = findDataRowById_(sheet, id);
    const rowIndex = existingRow || sheet.getLastRow() + 1;
    const row = [
      id, parseDate_(date), safeSheetText_(category), safeSheetText_(subject), safeSheetText_(description),
      dueDate ? parseDate_(dueDate) : "", status, safeSheetText_(history), folder.getUrl(), now
    ];
    setOperationFields_(reservation.row, { stage: "SHEET_COMMITTING", rowIndex: rowIndex });
    if (!existingRow) {
      sheet.getRange(rowIndex, 1, 1, DATA_HEADERS.length).setValues([row]);
      sheet.getRange(rowIndex, 2).setNumberFormat("yyyy-mm-dd");
      sheet.getRange(rowIndex, 6).setNumberFormat("yyyy-mm-dd");
      sheet.getRange(rowIndex, 10).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    }
    rowWritten = true;
    bumpMetadataCacheVersion_();
    const actualRow = existingRow || rowIndex;
    const actualValues = sheet.getRange(actualRow, 1, 1, DATA_HEADERS.length).getValues()[0];
    const record = recordObject_(actualRow, actualValues);
    let taskWarning = "";
    try {
      upsertIndex_(indexSheet, {
        id: id, rowIndex: actualRow, folderId: folder.getId(), taskListId: "", taskId: ""
      });
    } catch (indexErr) {
      taskWarning = "案件已建立，但系統索引更新失敗；Tasks 同步或資料夾連結可能需要重試。";
    }
    if (payload.addToTasks !== false) {
      try {
        const synced = syncRecordTask_(record, false, false, true);
        record.taskId = synced.id;
        record.taskUrl = synced.webViewLink || "";
      } catch (err) {
        taskWarning = (taskWarning ? taskWarning + " " : "") + "Tasks 同步失敗：" + errorMessage_(err);
      }
    }
    result = { record: recordCardObject_(record), taskWarning: taskWarning };
    finishOperation_(reservation.row, requestId, "CREATE", result, {
      recordId: id, rowIndex: actualRow, folderId: folder.getId()
    });
  } catch (err) {
    if (!rowWritten) {
      uploaded.forEach(function (file) {
        try { DriveApp.getFileById(file.id).setTrashed(true); } catch (cleanupFileError) {}
      });
      if (folder) {
        try { folder.setTrashed(true); } catch (cleanupFolderError) {}
      }
      try {
        setOperationFields_(reservation.row, reservation.isNew
          ? { state: "FAILED", stage: "FAILED_CLEAN", folderId: "" }
          : { state: "PENDING", stage: "RECOVERY_REQUIRED" });
      } catch (logError) {}
    } else {
      try { setOperationFields_(reservation.row, { state: "PENDING", stage: "SHEET_COMMITTED" }); } catch (logError) {}
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
  return result;
}

function apiUpdateRecord(payload) {
  payload = payload || {};
  assertPayloadSize_(payload);
  const requestId = requiredText_(payload.clientRequestId, "clientRequestId", 100);
  const id = requiredText_(payload.id, "資料ID", 100);
  const rowIndex = Number(payload.rowIndex);
  const newStatus = normalizeStatus_(payload.status);
  const manualMode = payload.manualMode === true;
  const hasDate = Object.prototype.hasOwnProperty.call(payload, "date");
  const hasCategory = Object.prototype.hasOwnProperty.call(payload, "category");
  const hasSubject = Object.prototype.hasOwnProperty.call(payload, "subject");
  const hasDescription = Object.prototype.hasOwnProperty.call(payload, "description");
  const hasDueDate = Object.prototype.hasOwnProperty.call(payload, "dueDate");
  const requestedDate = hasDate ? normalizeDate_(payload.date, true) : null;
  const requestedCategory = hasCategory ? requiredText_(payload.category, "標籤類別", 100) : null;
  const requestedSubject = hasSubject ? requiredText_(payload.subject, "案件/公文主旨", 500) : null;
  const requestedDescription = hasDescription ? optionalText_(payload.description, 20000) : null;
  const requestedDueDate = hasDueDate ? normalizeDate_(payload.dueDate, false) : null;
  const files = normalizeFiles_(payload.files);
  const progressText = optionalText_(payload.progressText, 10000);
  const fullHistory = optionalText_(payload.fullHistory, MAX_HISTORY_CHARS);
  const fingerprint = payloadFingerprint_(payload);
  const reservation = beginOperation_(requestId, "UPDATE", fingerprint);
  if (reservation.state === "DONE") return reservation.result;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let uploaded = [];
  let sheetCommitted = false;
  let result;
  try {
    const op = readOperationRow_(reservation.row);
    if (op.state === "DONE" && op.result) return op.result;
    if (!reservation.isNew) {
      const sheet = getDataSheet_(getSpreadsheet_());
      const recoveredRow = resolveRowIndex_(sheet, id, rowIndex);
      if (String(op.stage).indexOf("SHEET_COMMITTED") !== 0) {
        throw new Error("這筆更新曾開始但結果尚未確認。為避免把進度重複累加，請重新載入案件確認最新時間軸，再決定是否重新輸入。");
      }
      const values = sheet.getRange(recoveredRow, 1, 1, DATA_HEADERS.length).getValues()[0];
      const recoveredRecord = recordObject_(recoveredRow, values);
      const recoveredIndex = findIndexEntry_(getIndexSheet_(getSpreadsheet_()), id);
      const recoveredFolderId = recoveredIndex && recoveredIndex.folderId
        ? recoveredIndex.folderId : folderIdFromUrl_(recoveredRecord.folderUrl);
      let recoveryWarning = "";
      try {
        upsertIndex_(getIndexSheet_(getSpreadsheet_()), {
          id: id, rowIndex: recoveredRow, folderId: recoveredFolderId,
          taskListId: recoveredIndex ? recoveredIndex.taskListId : "",
          taskId: recoveredIndex ? recoveredIndex.taskId : ""
        });
        if (op.stage.indexOf("_FOLDER_NAME") !== -1) renameCaseFolder_(recoveredRecord, recoveredFolderId);
        if (op.stage.indexOf("_COMPLETE") !== -1 || op.stage.indexOf("_REOPEN") !== -1) {
          setLinkedTaskCompleted_(id, op.stage.indexOf("_COMPLETE") !== -1);
        }
        if (op.stage.indexOf("_TASK_DETAILS") !== -1) {
          syncRecordTask_(recoveredRecord, true, true, false);
        }
      } catch (recoveryError) {
        recoveryWarning = "案件已更新；索引或 Tasks 補同步失敗：" + errorMessage_(recoveryError);
      }
      result = { record: recordCardObject_(recoveredRecord), taskWarning: recoveryWarning };
      finishOperation_(reservation.row, requestId, "UPDATE", result, {
        recordId: id, rowIndex: recoveredRow, folderId: recoveredFolderId
      });
      return result;
    }

    const ss = getSpreadsheet_();
    const sheet = getDataSheet_(ss);
    const indexSheet = getIndexSheet_(ss);
    const resolvedRow = resolveRowIndex_(sheet, id, rowIndex);
    const old = sheet.getRange(resolvedRow, 1, 1, DATA_HEADERS.length).getValues()[0];
    const oldStatus = String(old[6] || "待辦");
    const oldHistory = unsafeSheetText_(old[7]);
    const oldDate = dateString_(old[1]);
    const oldCategory = unsafeSheetText_(old[2]);
    const oldSubject = unsafeSheetText_(old[3]);
    const oldDescription = unsafeSheetText_(old[4]);
    const oldDueDate = dateString_(old[5]);
    const recordDate = hasDate ? requestedDate : oldDate;
    const category = hasCategory ? requestedCategory : oldCategory;
    const subject = hasSubject ? requestedSubject : oldSubject;
    const description = hasDescription ? requestedDescription : oldDescription;
    const dueDate = hasDueDate ? requestedDueDate : oldDueDate;
    const basicFieldsChanged = recordDate !== oldDate || category !== oldCategory ||
      subject !== oldSubject || description !== oldDescription || dueDate !== oldDueDate;
    const folderNameChanged = recordDate !== oldDate || category !== oldCategory || subject !== oldSubject;
    const taskDetailsChanged = category !== oldCategory || subject !== oldSubject || dueDate !== oldDueDate;
    const taskStateAction = newStatus === "已結案" ? "complete" :
      (oldStatus === "已結案" ? "reopen" : "");
    let committedStage = "SHEET_COMMITTED";
    if (taskStateAction) committedStage += "_" + taskStateAction.toUpperCase();
    if (taskDetailsChanged) committedStage += "_TASK_DETAILS";
    if (folderNameChanged) committedStage += "_FOLDER_NAME";
    const indexEntry = findIndexEntry_(indexSheet, id);
    const folderId = indexEntry && indexEntry.folderId
      ? indexEntry.folderId
      : folderIdFromUrl_(String(old[8] || ""));
    if (!folderId) throw new Error("找不到此案件的 Drive 資料夾，請檢查資料夾連結或系統索引。");
    const folder = DriveApp.getFolderById(folderId);
    if (folder.isTrashed()) {
      throw new Error("此案件的專屬資料夾位於 Google Drive 垃圾桶中，請先從垃圾桶還原資料夾後再更新。");
    }
    const now = new Date();
    const appendProgressBlock = !!progressText || files.length > 0 || oldStatus !== newStatus;
    const historyChanged = manualMode && fullHistory !== oldHistory;
    const progressChanged = appendProgressBlock || historyChanged;
    if (!progressChanged && !basicFieldsChanged) {
      throw new Error("請輸入進度、上傳附件或變更狀態後再儲存。");
    }
    const uploadPlan = prepareUploadNames_(folder, files, "progress", now, requestId);
    const expectedFiles = uploadPlan.names.map(function (name) { return { name: name }; });
    let newHistory;
    if (manualMode) {
      newHistory = fullHistory;
      if (appendProgressBlock) {
        const block = makeProgressBlock_(formatDateTime_(now), newStatus, progressText, expectedFiles);
        newHistory = block + (fullHistory ? "\n----------------------------------------\n" + fullHistory : "");
      }
    } else if (appendProgressBlock) {
      const block = makeProgressBlock_(formatDateTime_(now), newStatus, progressText, expectedFiles);
      newHistory = block + (oldHistory ? "\n----------------------------------------\n" + oldHistory : "");
    } else {
      newHistory = oldHistory;
    }
    ensureHistoryFits_(safeSheetText_(newHistory));
    setOperationFields_(reservation.row, {
      state: "PENDING", stage: "PLAN_READY", recordId: id,
      rowIndex: resolvedRow, folderId: folderId
    });

    uploaded = [];
    saveFiles_(folder, files, "progress", now, requestId, function (file) {
      uploaded.push(file);
    }, uploadPlan);
    setOperationFields_(reservation.row, { stage: "FILES_SAVED" });
    sheet.getRange(resolvedRow, 2, 1, 7).setValues([[
      parseDate_(recordDate), safeSheetText_(category), safeSheetText_(subject),
      safeSheetText_(description), dueDate ? parseDate_(dueDate) : "",
      newStatus, safeSheetText_(newHistory)
    ]]);
    sheet.getRange(resolvedRow, 2).setNumberFormat("yyyy-mm-dd");
    sheet.getRange(resolvedRow, 6).setNumberFormat("yyyy-mm-dd");
    sheetCommitted = true;
    bumpMetadataCacheVersion_();
    setOperationFields_(reservation.row, { stage: committedStage });
    try {
      upsertIndex_(indexSheet, {
        id: id, rowIndex: resolvedRow, folderId: folderId,
        taskListId: indexEntry ? indexEntry.taskListId : "",
        taskId: indexEntry ? indexEntry.taskId : ""
      });
    } catch (indexErr) {
      // The direct row update is committed; the next request can repair the index.
    }
    old[1] = parseDate_(recordDate);
    old[2] = category;
    old[3] = subject;
    old[4] = description;
    old[5] = dueDate ? parseDate_(dueDate) : "";
    old[6] = newStatus;
    old[7] = newHistory;
    const updatedRecord = recordCardObject_(recordObject_(resolvedRow, old));
    let taskWarning = "";
    if (folderNameChanged) {
      try { renameCaseFolder_(updatedRecord, folderId); }
      catch (err) { throw new Error("案件資料已更新，但資料夾重新命名失敗；請以相同請求重試。" + errorMessage_(err)); }
    }
    if (taskStateAction) {
      try { setLinkedTaskCompleted_(id, taskStateAction === "complete"); }
      catch (err) { taskWarning = "案件狀態已更新，但 Tasks 狀態同步失敗：" + errorMessage_(err); }
    }
    if (taskDetailsChanged) {
      try {
        const linkedTask = syncRecordTask_(updatedRecord, true, true, false);
        if (!linkedTask && indexEntry && indexEntry.taskId) {
          taskWarning = (taskWarning ? taskWarning + " " : "") + "找不到原本連結的 Tasks 任務，未建立重複任務。";
        }
      } catch (err) {
        taskWarning = (taskWarning ? taskWarning + " " : "") + "案件基本資料已更新，但 Tasks 主旨或期限同步失敗：" + errorMessage_(err);
      }
    }
    result = { record: updatedRecord, taskWarning: taskWarning };
    finishOperation_(reservation.row, requestId, "UPDATE", result, {
      recordId: id, rowIndex: resolvedRow, folderId: folderId
    });
  } catch (err) {
    if (!sheetCommitted) {
      uploaded.forEach(function (file) {
        try { DriveApp.getFileById(file.id).setTrashed(true); } catch (cleanupError) {}
      });
      try {
        setOperationFields_(reservation.row, reservation.isNew
          ? { state: "FAILED", stage: "FAILED_CLEAN" }
          : { state: "PENDING", stage: "RECOVERY_REQUIRED" });
      } catch (logError) {}
    } else {
      try { setOperationFields_(reservation.row, { state: "PENDING", stage: committedStage }); } catch (logError) {}
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
  return result;
}

function apiLoadTasks(pageToken) {
  const list = ensureTasksList_();
  const options = { showCompleted: true, showHidden: true, maxResults: TASK_PAGE_SIZE };
  if (pageToken) options.pageToken = String(pageToken);
  const response = Tasks.Tasks.list(list.id, options);
  const tasks = (response.items || []).filter(function (task) {
    return !task.deleted;
  }).map(function (task) {
    return {
      id: task.id, title: task.title || "", notes: task.notes || "",
      status: task.status || "needsAction",
      dueDate: task.due ? String(task.due).slice(0, 10) : "",
      completed: task.status === "completed", webViewLink: task.webViewLink || ""
    };
  });
  return {
    listId: list.id, title: list.title, tasks: tasks,
    nextPageToken: response.nextPageToken || "",
    openCount: pageToken ? null : cachedOpenTaskCount_(list.id)
  };
}

function apiToggleTask(taskId, completed) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const list = ensureTasksList_();
    const id = String(taskId);
    const before = Tasks.Tasks.get(list.id, id);
    const wasOpen = before.status !== "completed";
    const body = completed
      ? { status: "completed", completed: new Date().toISOString() }
      : { status: "needsAction", completed: null };
    const task = Tasks.Tasks.patch(body, list.id, id);
    const isOpen = task.status !== "completed";
    if (wasOpen !== isOpen) adjustOpenTaskCount_(list.id, isOpen ? 1 : -1);
    return { id: task.id, status: task.status, completed: task.status === "completed" };
  } finally {
    lock.releaseLock();
  }
}

function apiAddQuickTask(title, dueDate) {
  const taskTitle = requiredText_(title, "任務標題", 1024);
  const date = normalizeDate_(dueDate, false);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const list = ensureTasksList_();
    const body = { title: taskTitle, status: "needsAction" };
    if (date) body.due = date + "T00:00:00.000Z";
    const task = Tasks.Tasks.insert(body, list.id);
    adjustOpenTaskCount_(list.id, 1);
    return simplifyTask_(task);
  } finally {
    lock.releaseLock();
  }
}

function apiSyncRecordToTask(id, rowIndex) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getDataSheet_(getSpreadsheet_());
    const resolvedRow = resolveRowIndex_(sheet, String(id), Number(rowIndex));
    const left = sheet.getRange(resolvedRow, 1, 1, 7).getValues()[0];
    const right = sheet.getRange(resolvedRow, 9, 1, 2).getValues()[0];
    const record = {
      rowIndex: resolvedRow, id: String(left[0] || ""),
      date: dateString_(left[1]), category: String(left[2] || ""),
      subject: String(left[3] || ""), description: String(left[4] || ""),
      dueDate: dateString_(left[5]), status: String(left[6] || ""),
      folderUrl: String(right[0] || ""), createdAt: dateTimeString_(right[1])
    };
    return simplifyTask_(syncRecordTask_(record, true, true, true));
  } finally {
    lock.releaseLock();
  }
}

function apiDeleteTask(taskId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const list = ensureTasksList_();
    const id = String(taskId);
    const task = Tasks.Tasks.get(list.id, id);
    Tasks.Tasks.remove(list.id, id);
    if (task.status !== "completed") adjustOpenTaskCount_(list.id, -1);
    return { deleted: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function monthlySpreadsheetBackup() {
  const ss = getSpreadsheet_();
  const root = getRootFolder_();
  const backupFolder = ensureBackupFolder_(root);
  const month = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM");
  const name = "消防小本本備份_" + month;
  const existing = backupFolder.getFilesByName(name);
  if (existing.hasNext()) {
    const file = existing.next();
    pruneBackupFiles_(backupFolder);
    return { name: name, url: file.getUrl(), alreadyExists: true };
  }
  const copy = DriveApp.getFileById(ss.getId()).makeCopy(name, backupFolder);
  pruneBackupFiles_(backupFolder);
  return { name: name, url: copy.getUrl(), alreadyExists: false };
}

function pruneBackupFiles_(backupFolder) {
  const files = backupFolder.getFiles();
  const backups = [];
  while (files.hasNext()) {
    const file = files.next();
    if (/^消防小本本備份_\d{4}-\d{2}$/.test(file.getName())) {
      backups.push({ file: file, name: file.getName(), created: file.getDateCreated().getTime() });
    }
  }
  backups.sort(function (a, b) {
    return b.created - a.created || b.name.localeCompare(a.name);
  });
  backups.slice(MAX_BACKUP_FILES).forEach(function (item) { item.file.setTrashed(true); });
  return Math.min(backups.length, MAX_BACKUP_FILES);
}

function getOperationSheet_(ss) {
  ss = ss || getSpreadsheet_();
  let sheet = ss.getSheetByName(OPERATION_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(OPERATION_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, OPERATION_HEADERS.length).setValues([OPERATION_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  } else {
    const actual = sheet.getRange(1, 1, 1, OPERATION_HEADERS.length).getDisplayValues()[0];
    if (OPERATION_HEADERS.some(function (header, i) { return actual[i] !== header; })) {
      throw new Error("操作紀錄工作表標頭不正確，請勿修改隱藏的 _操作紀錄 表頭。");
    }
  }
  return sheet;
}

function installOperationCleanupTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "cleanupOperationLog") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("cleanupOperationLog").timeBased().everyDays(1).atHour(4).create();
}

function cleanupOperationLog() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    cleanupOperationLog_();
    cleanupOrphanIndexEntries_();
  }
  finally { lock.releaseLock(); }
}

function cleanupOrphanIndexEntries_() {
  const ss = getSpreadsheet_();
  const data = getDataSheet_(ss);
  const index = getIndexSheet_(ss);
  const dataLastRow = data.getLastRow();
  const indexLastRow = index.getLastRow();
  if (indexLastRow < 2) return 0;
  const activeIds = {};
  if (dataLastRow >= 2) {
    data.getRange(2, 1, dataLastRow - 1, 1).getDisplayValues().forEach(function (value) {
      const id = String(value[0] || "");
      if (id) activeIds[id] = true;
    });
  }
  const indexIds = index.getRange(2, 1, indexLastRow - 1, 1).getDisplayValues();
  const rows = [];
  indexIds.forEach(function (value, offset) {
    const id = String(value[0] || "");
    if (!id || !activeIds[id]) rows.push(offset + 2);
  });
  rows.sort(function (a, b) { return a - b; });
  const groups = [];
  rows.forEach(function (row) {
    const last = groups[groups.length - 1];
    if (last && row === last.start + last.count) last.count++;
    else groups.push({ start: row, count: 1 });
  });
  groups.reverse().forEach(function (group) { index.deleteRows(group.start, group.count); });
  return rows.length;
}

function cleanupOperationLog_(maxRows) {
  const sheet = getOperationSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const values = sheet.getRange(2, 1, lastRow - 1, OPERATION_HEADERS.length).getValues();
  const cutoff = Date.now() - OPERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const keep = [];
  const remove = [];
  values.forEach(function (value, index) {
    const updated = value[9] instanceof Date ? value[9].getTime() : new Date(value[9]).getTime();
    const row = index + 2;
    if (!isFinite(updated) || updated < cutoff) remove.push(row);
    else keep.push({ row: row, updated: updated });
  });
  const rowLimit = maxRows == null ? MAX_OPERATION_ROWS : Math.max(0, Number(maxRows));
  if (keep.length > rowLimit) {
    keep.sort(function (a, b) { return a.updated - b.updated; });
    keep.slice(0, keep.length - rowLimit).forEach(function (item) { remove.push(item.row); });
  }
  if (!remove.length) return;
  remove.sort(function (a, b) { return a - b; });
  const groups = [];
  remove.forEach(function (row) {
    const last = groups[groups.length - 1];
    if (last && row === last.start + last.count) last.count++;
    else groups.push({ start: row, count: 1 });
  });
  groups.reverse().forEach(function (group) { sheet.deleteRows(group.start, group.count); });
}

function requestCacheKey_(requestId, operation) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(operation) + "|" + String(requestId));
  return "REQUEST_DONE_" + Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}

function cachedRequestResult_(requestId, operation, fingerprint) {
  try {
    const value = CacheService.getScriptCache().get(requestCacheKey_(requestId, operation));
    if (!value) return null;
    const cached = JSON.parse(value);
    return cached && cached.fingerprint === fingerprint ? cached.result : null;
  } catch (err) { return null; }
}

function cacheRequestResult_(requestId, operation, result, fingerprint) {
  try {
    const json = JSON.stringify({ fingerprint: fingerprint, result: result });
    if (Utilities.newBlob(json).getBytes().length < 95000) {
      CacheService.getScriptCache().put(requestCacheKey_(requestId, operation), json, REQUEST_CACHE_TTL_SECONDS);
    }
  } catch (err) {
    // The hidden operation sheet is the durable fallback.
  }
}

function payloadFingerprint_(payload) {
  const copy = {};
  Object.keys(payload || {}).forEach(function (key) {
    if (key !== "files" && key !== "clientRequestId") copy[key] = payload[key];
  });
  copy.files = (payload && Array.isArray(payload.files) ? payload.files : []).map(function (file) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(file && file.data || ""));
    return {
      name: String(file && file.name || ""),
      mimeType: String(file && file.mimeType || ""),
      digest: Utilities.base64EncodeWebSafe(digest)
    };
  });
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(copy));
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}

function beginOperation_(requestId, operation, fingerprint) {
  const cached = cachedRequestResult_(requestId, operation, fingerprint);
  if (cached) return { state: "DONE", result: cached, row: 0, isNew: false };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getOperationSheet_();
    const last = sheet.getLastRow();
    if (last >= 2) {
      const found = sheet.getRange(2, 1, last - 1, 1)
        .createTextFinder(requestId).matchCase(true).matchEntireCell(true).findNext();
      if (found) {
        const row = found.getRow();
        const op = readOperationRow_(row);
        if (op.operation !== operation) throw new Error("此請求 ID 已用於另一種操作。");
        if (op.payloadFingerprint !== fingerprint) throw new Error("此請求 ID 已綁定不同內容；請重新開啟表單再送出。");
        if (op.state === "DONE" && op.result) {
          cacheRequestResult_(requestId, operation, op.result, op.payloadFingerprint);
          return { state: "DONE", result: op.result, row: row, isNew: false };
        }
        if (op.state === "FAILED") {
          setOperationFields_(row, { state: "PENDING", stage: "RETRYING", resultJson: "" });
          return { state: "PENDING", row: row, isNew: true };
        }
        return {
          state: op.state || "PENDING", row: row, isNew: false,
          recordId: op.recordId, stage: op.stage
        };
      }
    }
    // Keep the log under its data-row cap, but only scan/prune when the next
    // insert would exceed the cap. Expired rows are otherwise removed daily.
    if (Math.max(0, sheet.getLastRow() - 1) >= MAX_OPERATION_ROWS) {
      cleanupOperationLog_(MAX_OPERATION_ROWS - 1);
    }
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, OPERATION_HEADERS.length).setValues([[
      requestId, operation, "PENDING", "RESERVED", fingerprint, "", "", "", "", new Date()
    ]]);
    return { state: "PENDING", row: row, isNew: true };
  } finally {
    lock.releaseLock();
  }
}

function readOperationRow_(row) {
  const values = getOperationSheet_().getRange(row, 1, 1, OPERATION_HEADERS.length).getValues()[0];
  return {
    requestId: String(values[0] || ""), operation: String(values[1] || ""),
    state: String(values[2] || ""), stage: String(values[3] || ""),
    payloadFingerprint: String(values[4] || ""), recordId: String(values[5] || ""),
    rowIndex: Number(values[6] || 0), folderId: String(values[7] || ""),
    result: parseJsonSafe_(values[8], null)
  };
}

function setOperationFields_(row, patch) {
  const sheet = getOperationSheet_();
  const range = sheet.getRange(row, 1, 1, OPERATION_HEADERS.length);
  const values = range.getValues()[0];
  const columns = {
    requestId: 0, operation: 1, state: 2, stage: 3, payloadFingerprint: 4,
    recordId: 5, rowIndex: 6, folderId: 7, resultJson: 8
  };
  Object.keys(patch).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(columns, key)) values[columns[key]] = patch[key];
  });
  values[9] = new Date();
  range.setValues([values]);
}

function finishOperation_(row, requestId, operation, result, details) {
  const patch = Object.assign({}, details || {}, {
    state: "DONE", stage: "DONE", resultJson: JSON.stringify(result)
  });
  setOperationFields_(row, patch);
  const operationRow = readOperationRow_(row);
  cacheRequestResult_(requestId, operation, result, operationRow.payloadFingerprint);
}

function parseJsonSafe_(value, fallback) {
  try { return value ? JSON.parse(String(value)) : fallback; }
  catch (err) { return fallback; }
}

function assertPayloadSize_(payload) {
  const size = Utilities.newBlob(JSON.stringify(payload || {}), "application/json").getBytes().length;
  if (size > MAX_REQUEST_JSON_BYTES) throw new Error("檔案合計過大，請分批上傳或只留重點附件");
}

function findDataRowById_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const found = sheet.getRange(2, 1, last - 1, 1)
    .createTextFinder(String(id)).matchCase(true).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function installMetadataInvalidationTriggers_(ss) {
  const handlers = ["invalidateMetadataOnEdit", "invalidateMetadataOnChange"];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("invalidateMetadataOnEdit").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("invalidateMetadataOnChange").forSpreadsheet(ss).onChange().create();
}

function invalidateMetadataOnEdit(event) {
  if (event && event.range && event.range.getSheet().getName() === DATA_SHEET_NAME) {
    bumpMetadataCacheVersion_();
  }
}

function invalidateMetadataOnChange(event) {
  if (event && event.source && event.source.getId() === getSpreadsheet_().getId()) {
    bumpMetadataCacheVersion_();
  }
}

function taskCountCacheKey_(taskListId) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(taskListId));
  return "TASK_OPEN_COUNT_" + Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}

function cachedOpenTaskCount_(taskListId) {
  const cache = CacheService.getScriptCache();
  const key = taskCountCacheKey_(taskListId);
  let value = cache.get(key);
  if (value !== null) return Number(value);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    value = cache.get(key);
    if (value !== null) return Number(value);
    const count = countOpenTasks_(taskListId);
    cache.put(key, String(count), TASK_COUNT_CACHE_TTL_SECONDS);
    return count;
  } finally {
    lock.releaseLock();
  }
}

function adjustOpenTaskCount_(taskListId, delta) {
  const cache = CacheService.getScriptCache();
  const key = taskCountCacheKey_(taskListId);
  const value = cache.get(key);
  if (value !== null) {
    cache.put(key, String(Math.max(0, Number(value) + Number(delta))), TASK_COUNT_CACHE_TTL_SECONDS);
  }
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("SPREADSHEET_ID") || SPREADSHEET_ID;
  if (!id) {
    const ss = SpreadsheetApp.create("消防小本本");
    id = ss.getId();
    props.setProperty("SPREADSHEET_ID", id);
  }
  return SpreadsheetApp.openById(id);
}

function getDataSheet_(ss) {
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) {
    const sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheet = sheets[0];
      sheet.setName(DATA_SHEET_NAME);
    } else {
      sheet = ss.insertSheet(DATA_SHEET_NAME);
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, DATA_HEADERS.length).setFontWeight("bold").setWrap(true);
    sheet.setColumnWidth(1, 190);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 100);
    sheet.setColumnWidth(4, 380);
    sheet.setColumnWidth(5, 420);
    sheet.setColumnWidth(6, 120);
    sheet.setColumnWidth(7, 100);
    sheet.setColumnWidth(8, 520);
    sheet.setColumnWidth(9, 260);
    sheet.setColumnWidth(10, 180);
  } else {
    const actual = sheet.getRange(1, 1, 1, DATA_HEADERS.length).getDisplayValues()[0];
    if (DATA_HEADERS.some(function (header, i) { return actual[i] !== header; })) {
      throw new Error("工作表「" + DATA_SHEET_NAME + "」第一列欄位與規格不一致。請先備份並修正欄名。");
    }
  }
  return sheet;
}

function getIndexSheet_(ss) {
  let sheet = ss.getSheetByName(INDEX_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(INDEX_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, INDEX_HEADERS.length).setValues([INDEX_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  } else {
    const actual = sheet.getRange(1, 1, 1, INDEX_HEADERS.length).getDisplayValues()[0];
    if (INDEX_HEADERS.some(function (header, i) { return actual[i] !== header; })) {
      throw new Error("系統索引工作表標頭不正確。");
    }
  }
  return sheet;
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folderId = (ROOT_FOLDER_ID && ROOT_FOLDER_ID !== "YOUR_FOLDER_ID")
    ? ROOT_FOLDER_ID
    : (props.getProperty("ROOT_FOLDER_ID") || "");

  if (!folderId) {
    // 自動從既有案件資料夾反查母資料夾 ID，避免貼上程式碼時遺失設定
    try {
      const ss = getSpreadsheet_();
      const idxSheet = ss.getSheetByName(INDEX_SHEET_NAME);
      if (idxSheet && idxSheet.getLastRow() >= 2) {
        const vals = idxSheet.getRange(2, 3, Math.min(10, idxSheet.getLastRow() - 1), 1).getDisplayValues();
        for (let i = 0; i < vals.length; i++) {
          const childId = String(vals[i][0] || "").trim();
          if (childId) {
            const parents = DriveApp.getFolderById(childId).getParents();
            if (parents.hasNext()) {
              folderId = parents.next().getId();
              break;
            }
          }
        }
      }
    } catch (ignore) {}
  }

  if (!folderId) {
    throw new Error("請先在 Code.gs 將 ROOT_FOLDER_ID 設為 Drive 母資料夾 ID。");
  }
  if (props.getProperty("ROOT_FOLDER_ID") !== folderId) {
    props.setProperty("ROOT_FOLDER_ID", folderId);
  }
  return DriveApp.getFolderById(folderId);
}

function ensureBackupFolder_(root) {
  const folders = root.getFoldersByName(BACKUP_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return root.createFolder(BACKUP_FOLDER_NAME);
}

function installMonthlyBackupTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "monthlySpreadsheetBackup") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("monthlySpreadsheetBackup").timeBased().onMonthDay(1).atHour(3).create();
}

function readMetadata_() {
  const ss = getSpreadsheet_();
  const sheet = getDataSheet_(ss);
  const spreadsheetId = ss.getId();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { records: [], rowById: {} };
  const count = lastRow - 1;
  const properties = PropertiesService.getScriptProperties();
  const version = properties.getProperty("METADATA_CACHE_VERSION") || "1";
  const cache = CacheService.getScriptCache();
  const chunks = [];
  for (let offset = 0; offset < count; offset += METADATA_CACHE_CHUNK_SIZE) {
    chunks.push({
      offset: offset,
      length: Math.min(METADATA_CACHE_CHUNK_SIZE, count - offset),
      key: "META_" + spreadsheetId + "_" + version + "_" + offset + "_" + Math.min(METADATA_CACHE_CHUNK_SIZE, count - offset)
    });
  }
  const cachedValues = {};
  const keys = chunks.map(function (chunk) { return chunk.key; });
  for (let i = 0; i < keys.length; i += 100) {
    try { Object.assign(cachedValues, cache.getAll(keys.slice(i, i + 100)) || {}); } catch (err) {}
  }
  const parsed = {};
  const missing = [];
  chunks.forEach(function (chunk) {
    try {
      const value = cachedValues[chunk.key];
      const records = value ? JSON.parse(value) : null;
      if (Array.isArray(records)) parsed[chunk.key] = records;
      else missing.push(chunk);
    } catch (err) {
      missing.push(chunk);
    }
  });
  if (missing.length) {
    // The cache is a short-lived optimization only. Cache misses always fall
    // back to the sheet, and long text columns E/H are excluded from this read.
    const left = sheet.getRange(2, 1, count, 4).getValues();
    const middle = sheet.getRange(2, 6, count, 2).getValues();
    const right = sheet.getRange(2, 9, count, 2).getValues();
    const allRows = left.map(function (v, i) {
      return {
        rowIndex: i + 2,
        id: String(v[0] || ""),
        date: dateString_(v[1]),
        category: String(v[2] || ""),
        subject: String(v[3] || ""),
        dueDate: dateString_(middle[i][0]),
        status: String(middle[i][1] || ""),
        folderUrl: String(right[i][0] || ""),
        createdAt: dateTimeString_(right[i][1])
      };
    }).filter(function (record) { return !!record.id; });
    const rowsByOffset = {};
    allRows.forEach(function (record) {
      const offset = Math.floor((record.rowIndex - 2) / METADATA_CACHE_CHUNK_SIZE) * METADATA_CACHE_CHUNK_SIZE;
      if (!rowsByOffset[offset]) rowsByOffset[offset] = [];
      rowsByOffset[offset].push(record);
    });
    const valuesToCache = {};
    missing.forEach(function (chunk) {
      const records = rowsByOffset[chunk.offset] || [];
      parsed[chunk.key] = records;
      valuesToCache[chunk.key] = JSON.stringify(records);
    });
    const cacheKeys = Object.keys(valuesToCache);
    for (let i = 0; i < cacheKeys.length; i += 100) {
      const batch = {};
      cacheKeys.slice(i, i + 100).forEach(function (key) { batch[key] = valuesToCache[key]; });
      try {
        cache.putAll(batch, METADATA_CACHE_TTL_SECONDS);
      } catch (err) {
        Object.keys(batch).forEach(function (key) {
          try { cache.put(key, batch[key], METADATA_CACHE_TTL_SECONDS); } catch (cacheErr) {}
        });
      }
    }
    const rowById = {};
    allRows.forEach(function (record) { rowById[record.id] = record.rowIndex; });
    return { records: allRows, rowById: rowById };
  }
  const records = chunks.reduce(function (all, chunk) {
    return all.concat(parsed[chunk.key] || []);
  }, []);
  // The short-lived metadata cache may have been populated before a user
  // manually sorted the sheet. Refresh only the ID-to-row map so hydration
  // still reads the correct current rows without rereading A in hydrateRecords_.
  return { records: records, rowById: readRowIndexMap_(sheet, lastRow) };
}

function readRowIndexMap_(sheet, lastRow) {
  const rowById = {};
  if (lastRow < 2) return rowById;
  sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().forEach(function (value, index) {
    const id = String(value[0] || "");
    if (id) rowById[id] = index + 2;
  });
  return rowById;
}

function bumpMetadataCacheVersion_() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const current = Number(properties.getProperty("METADATA_CACHE_VERSION") || 1) || 1;
    properties.setProperty("METADATA_CACHE_VERSION", String(current + 1));
  } catch (err) {
    // A cache miss still reads current sheet values; the cache is never required for correctness.
  }
}

function pageRecords_(records, cursor) {
  let state = null;
  if (cursor) {
    try {
      state = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(String(cursor))).getDataAsString());
      if (!state || !state.snapshot || !state.last) throw new Error("invalid cursor");
      // Restart an old cursor from the first page during a rolling deployment.
      // The client merges records by ID, so this can repeat a page but cannot
      // skip urgent open records under the new ordering.
      if (state.v !== 2) {
        if (!state.snapshot.createdAt || !state.snapshot.id || !state.last.id) throw new Error("invalid legacy cursor");
        state = null;
      } else if (!state.snapshot.createdAt || !state.snapshot.id || !state.last.id ||
          typeof state.last.isOpen !== "boolean") {
        throw new Error("invalid cursor key");
      }
    } catch (err) {
      throw new Error("分頁游標不正確，請重新載入案件。");
    }
  }
  const sorted = records.slice().sort(function (a, b) {
    return compareRecordKey_(recordSortKey_(a), recordSortKey_(b));
  });
  if (!sorted.length) return { records: [], cursor: "", hasMore: false };
  const snapshot = state ? state.snapshot : records.reduce(function (latest, record) {
    const candidate = { createdAt: String(record.createdAt || ""), id: String(record.id || "") };
    return !latest || compareCreationKey_(candidate, latest) > 0 ? candidate : latest;
  }, null);
  const eligible = sorted.filter(function (record) {
    const key = recordSortKey_(record);
    const creationKey = { createdAt: key.createdAt, id: key.id };
    return compareCreationKey_(creationKey, snapshot) <= 0 &&
      (!state || compareRecordKey_(key, state.last) > 0);
  });
  const page = eligible.slice(0, RECORD_PAGE_SIZE);
  return {
    records: page,
    cursor: page.length ? Utilities.base64EncodeWebSafe(JSON.stringify({
      v: 2, snapshot: snapshot, last: recordSortKey_(page[page.length - 1])
    })) : "",
    hasMore: eligible.length > page.length
  };
}

function recordSortKey_(record) {
  return {
    isOpen: record.status === "待辦" || record.status === "辦理中",
    dueDate: String(record.dueDate || ""),
    date: String(record.date || ""),
    createdAt: String(record.createdAt || ""),
    id: String(record.id || "")
  };
}

function compareRecordKey_(a, b) {
  if (!!a.isOpen !== !!b.isOpen) return a.isOpen ? -1 : 1;
  if (a.isOpen) {
    const aDue = String(a.dueDate || "");
    const bDue = String(b.dueDate || "");
    if (aDue && !bDue) return -1;
    if (!aDue && bDue) return 1;
    if (aDue !== bDue) return aDue.localeCompare(bDue);
  } else {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare) return dateCompare;
  }
  const timeCompare = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  return timeCompare || String(b.id || "").localeCompare(String(a.id || ""));
}

function compareCreationKey_(a, b) {
  const timeCompare = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  return timeCompare || String(a.id || "").localeCompare(String(b.id || ""));
}

function archiveYearsFromMetadata_(rows, cutoff) {
  const yearSet = {};
  rows.forEach(function (r) {
    if (r.date && r.date < cutoff && r.date.length >= 4) yearSet[r.date.slice(0, 4)] = true;
  });
  return Object.keys(yearSet).sort().reverse();
}

function hydrateRecords_(metadata, retried, rowById) {
  if (!metadata.length) return [];
  const sheet = getDataSheet_(getSpreadsheet_());
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  rowById = rowById || readRowIndexMap_(sheet, lastRow);
  const ordered = metadata.map(function (record) {
    const row = rowById[String(record.id)];
    return row ? { id: String(record.id), rowIndex: row } : null;
  }).filter(Boolean).sort(function (a, b) { return a.rowIndex - b.rowIndex; });
  if (!ordered.length) return [];
  const hydrated = {};
  const windowSize = 300;
  const windows = {};
  ordered.forEach(function (entry) {
    const startRow = 2 + Math.floor((entry.rowIndex - 2) / windowSize) * windowSize;
    if (!windows[startRow]) windows[startRow] = [];
    windows[startRow].push(entry);
  });
  try {
    Object.keys(windows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (startRow) {
      const rowCount = Math.min(windowSize, lastRow - startRow + 1);
      const values = sheet.getRange(startRow, 1, rowCount, DATA_HEADERS.length).getValues();
      windows[startRow].forEach(function (entry) {
        const rowValues = values[entry.rowIndex - startRow];
        if (!rowValues || String(rowValues[0] || "") !== entry.id) throw new Error("ROW_ID_MISMATCH");
        hydrated[entry.id] = recordCardObject_(recordObject_(entry.rowIndex, rowValues));
      });
    });
  } catch (err) {
    if (String(err && err.message) === "ROW_ID_MISMATCH" && !retried) {
      return hydrateRecords_(metadata, true, readRowIndexMap_(sheet, sheet.getLastRow()));
    }
    throw new Error("試算表列剛有變動，請重新載入案件後再試。");
  }
  return metadata.map(function (record) { return hydrated[String(record.id)]; }).filter(Boolean);
}

function historyPreview_(history) {
  const firstEntry = String(history || "").split(/\r?\n-{10,}\r?\n/)[0].trim();
  return firstEntry.length > 500 ? firstEntry.slice(0, 500) + "…" : firstEntry;
}

function generateDocumentId_(sheet, now) {
  const datePart = Utilities.formatDate(now, TIME_ZONE, "yyyyMMdd");
  const prefix = "DOC-" + datePart + "-";
  const properties = PropertiesService.getScriptProperties();
  let state = {};
  try { state = JSON.parse(properties.getProperty("DOC_SEQUENCE_STATE") || "{}"); } catch (err) {}
  let sequence = Number(state.date === datePart ? state.sequence : 0) || 0;
  if (state.date !== datePart) {
    // Seed once per day for existing installations. Apps Script performs the
    // text search in Sheets rather than transferring the whole ID column.
    const matches = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
          .createTextFinder(prefix).matchCase(true).matchEntireCell(false).findAll()
      : [];
    matches.forEach(function (cell) {
      const value = String(cell.getDisplayValue() || "");
      if (value.indexOf(prefix) === 0) {
        const found = parseInt(value.slice(prefix.length), 10);
        if (!isNaN(found)) sequence = Math.max(sequence, found);
      }
    });
  }
  let id;
  do {
    sequence++;
    id = prefix + String(sequence).padStart(4, "0");
  } while (sheet.getLastRow() > 1 && sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(id).matchCase(true).matchEntireCell(true).findNext());
  properties.setProperty("DOC_SEQUENCE_STATE", JSON.stringify({ date: datePart, sequence: sequence }));
  return id;
}

function createCaseFolder_(category, date, subject, id, requestId) {
  const root = getRootFolder_();
  const name = caseFolderName_(category, date, subject, id, "");
  const folder = root.createFolder(name);
  if (requestId) folder.setDescription("消防小本本 requestId=" + requestId);
  return folder;
}

function caseFolderName_(category, date, subject, id, currentFolderId) {
  const baseName = sanitizeName_(category + "_" + date + "_" + subject);
  const matches = getRootFolder_().getFoldersByName(baseName);
  let hasOtherFolder = false;
  while (matches.hasNext()) {
    if (matches.next().getId() !== String(currentFolderId || "")) {
      hasOtherFolder = true;
      break;
    }
  }
  if (!hasOtherFolder) return baseName;
  const suffix = "_" + id;
  return baseName.slice(0, Math.max(1, 180 - suffix.length)) + suffix;
}

function renameCaseFolder_(record, folderId) {
  if (!folderId) throw new Error("找不到案件專屬資料夾 ID。");
  const folder = DriveApp.getFolderById(folderId);
  if (folder.isTrashed()) {
    throw new Error("此案件的專屬資料夾位於 Google Drive 垃圾桶中，請先從垃圾桶還原資料夾後再更新。");
  }
  const targetName = caseFolderName_(record.category, record.date, record.subject, record.id, folderId);
  if (folder.getName() !== targetName) folder.setName(targetName);
  return folder;
}

function prepareUploadNames_(folder, files, mode, now, requestId) {
  const markerPrefix = requestId ? "消防小本本 requestId=" + requestId + " file=" : "";
  const existingByMarker = {};
  const occupiedNames = {};
  const iterator = folder.getFiles();
  while (iterator.hasNext()) {
    const existing = iterator.next();
    const name = String(existing.getName() || "");
    occupiedNames["$" + name] = true;
    const description = String(existing.getDescription() || "");
    if (markerPrefix && description.indexOf(markerPrefix) === 0) existingByMarker[description] = existing;
  }
  const totals = {};
  const usedNames = {};
  const occurrences = {};
  const originals = files.map(function (file) { return sanitizeName_(file.name || "attachment"); });
  originals.forEach(function (name) {
    const key = "$" + name;
    totals[key] = (totals[key] || 0) + 1;
  });
  const progressStamp = Utilities.formatDate(now, TIME_ZONE, "MMdd_HHmm");
  const names = originals.map(function (originalName, index) {
    const key = "$" + originalName;
    occurrences[key] = (occurrences[key] || 0) + 1;
    const duplicate = totals[key] > 1;
    const marker = markerPrefix ? markerPrefix + mode + ":" + index : "";
    const priorFile = marker ? existingByMarker[marker] : null;
    if (priorFile) {
      const actualName = String(priorFile.getName() || "");
      usedNames["$" + actualName] = true;
      return actualName;
    }
    let prefix;
    if (mode === "original") {
      prefix = duplicate ? "[原件_" + occurrences[key] + "]_" : "[原件]_";
    } else {
      prefix = "[進度_" + progressStamp + (duplicate ? "_" + occurrences[key] : "") + "]_";
    }
    let candidate = prefix + originalName;
    let serial = 2;
    while (usedNames["$" + candidate] || occupiedNames["$" + candidate]) {
      candidate = prefix + addFileSerial_(originalName, serial++);
    }
    usedNames["$" + candidate] = true;
    occupiedNames["$" + candidate] = true;
    return candidate;
  });
  return { names: names, filesByMarker: existingByMarker };
}

function addFileSerial_(name, serial) {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? name.slice(0, dot) + " (" + serial + ")" + name.slice(dot)
    : name + " (" + serial + ")";
}

function saveFiles_(folder, files, mode, now, requestId, onFileCreated, preparedNames) {
  if (!files.length) return [];
  let totalBytes = 0;
  files.forEach(function (file) { totalBytes += base64DecodedSize_(file.data); });
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new Error("本次附件合計超過 " + Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024) + " MB。");
  }
  const plan = preparedNames && Array.isArray(preparedNames.names)
    ? preparedNames
    : prepareUploadNames_(folder, files, mode, now, requestId);
  const names = plan.names;
  const saved = [];
  files.forEach(function (file, index) {
    const marker = requestId ? "消防小本本 requestId=" + requestId + " file=" + mode + ":" + index : "";
    let existing = marker ? plan.filesByMarker[marker] || null : null;
    if (existing) {
      const reused = { name: existing.getName(), url: existing.getUrl(), id: existing.getId() };
      saved.push(reused);
      if (onFileCreated) onFileCreated(reused);
      return;
    }
    const bytes = Utilities.base64Decode(file.data);
    const mimeType = file.mimeType || "application/octet-stream";
    const created = folder.createFile(Utilities.newBlob(bytes, mimeType, names[index]));
    if (marker) created.setDescription(marker);
    const savedFile = { name: created.getName(), url: created.getUrl(), id: created.getId() };
    saved.push(savedFile);
    if (onFileCreated) onFileCreated(savedFile);
  });
  return saved;
}

function findFileByDescription_(folder, marker) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (String(file.getDescription() || "") === marker) return file;
  }
  return null;
}

function makeInitialHistory_(timestamp, status, files) {
  const attachmentLines = files.map(function (file) { return "📎 附檔：" + file.name; });
  const lines = ["⏱️ [" + timestamp + "] (狀態：" + status + ")", "案件建立"];
  return lines.concat(attachmentLines).join("\n");
}

function makeProgressBlock_(timestamp, status, content, files) {
  const lines = ["⏱️ [" + timestamp + "] (狀態：" + status + ")", content || ""];
  (files || []).forEach(function (file) { lines.push("📎 附檔：" + file.name); });
  return lines.join("\n").trim();
}

function ensureHistoryFits_(history) {
  if (String(history || "").length > MAX_HISTORY_CHARS) {
    throw new Error("進度時間軸將超過 Google 試算表單格的 50,000 字元上限。請先將較早歷史另存到案件 Drive 資料夾，再以全文手動修改整理後重試。附件尚未上傳。");
  }
}

function recordObject_(rowIndex, values) {
  return {
    rowIndex: rowIndex,
    id: String(values[0] || ""),
    date: dateString_(values[1]),
    category: unsafeSheetText_(values[2]),
    subject: unsafeSheetText_(values[3]),
    description: unsafeSheetText_(values[4]),
    dueDate: dateString_(values[5]),
    status: String(values[6] || ""),
    history: unsafeSheetText_(values[7]),
    folderUrl: String(values[8] || ""),
    createdAt: dateTimeString_(values[9])
  };
}

function recordCardObject_(record) {
  const card = Object.assign({}, record);
  card.historyPreview = historyPreview_(card.history || card.historyPreview || "");
  delete card.history;
  return card;
}

function resolveRowIndex_(sheet, id, rowIndex) {
  const lastRow = sheet.getLastRow();
  if (rowIndex >= 2 && rowIndex <= lastRow) {
    if (String(sheet.getRange(rowIndex, 1).getDisplayValue()) === id) return rowIndex;
  }
  if (lastRow >= 2) {
    const found = sheet.getRange(2, 1, lastRow - 1, 1)
      .createTextFinder(id).matchEntireCell(true).findNext();
    if (found) return found.getRow();
  }
  throw new Error("找不到資料ID「" + id + "」。請重新整理資料後再試。");
}

function findIndexEntry_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const found = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(id).matchEntireCell(true).findNext();
  if (!found) return null;
  const row = found.getRow();
  const values = sheet.getRange(row, 1, 1, INDEX_HEADERS.length).getValues()[0];
  return {
    rowIndex: row,
    id: String(values[0] || ""),
    dataRow: Number(values[1]),
    folderId: String(values[2] || ""),
    taskListId: String(values[3] || ""),
    taskId: String(values[4] || "")
  };
}

function upsertIndex_(sheet, entry) {
  const existing = findIndexEntry_(sheet, entry.id);
  const row = [
    entry.id, entry.rowIndex, entry.folderId || "", entry.taskListId || "",
    entry.taskId || "", new Date()
  ];
  if (existing) {
    sheet.getRange(existing.rowIndex, 1, 1, INDEX_HEADERS.length).setValues([row]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, INDEX_HEADERS.length).setValues([row]);
  }
}

function ensureTasksList_() {
  if (typeof Tasks === "undefined") {
    throw new Error("尚未啟用 Apps Script 的 Tasks API 進階服務。請先在「服務」中新增 Tasks API。");
  }
  const props = PropertiesService.getScriptProperties();
  const storedId = props.getProperty("TASK_LIST_ID");
  if (storedId) {
    let stored = null;
    try {
      stored = Tasks.Tasklists.get(storedId);
    } catch (err) {
      props.deleteProperty("TASK_LIST_ID");
    }
    if (stored) {
      if (stored.title === TASK_LIST_TITLE) return stored;
      const namedList = findTasksListByTitle_(TASK_LIST_TITLE);
      if (namedList) {
        props.setProperty("TASK_LIST_ID", namedList.id);
        return namedList;
      }
      // Rename the linked list in place so its existing tasks and IDs remain.
      try {
        const restored = Tasks.Tasklists.patch({ title: TASK_LIST_TITLE }, storedId);
        props.setProperty("TASK_LIST_ID", restored.id);
        return restored;
      } catch (renameError) {
        throw new Error("Google Tasks 清單已改名，但系統無法自動還原清單名稱；請確認 Tasks API 權限後重試。" + errorMessage_(renameError));
      }
    }
  }
  const existing = findTasksListByTitle_(TASK_LIST_TITLE);
  if (existing) {
    props.setProperty("TASK_LIST_ID", existing.id);
    return existing;
  }
  const created = Tasks.Tasklists.insert({ title: TASK_LIST_TITLE });
  props.setProperty("TASK_LIST_ID", created.id);
  return created;
}

function findTasksListByTitle_(title) {
  let pageToken;
  do {
    const listOptions = { maxResults: 1000 };
    if (pageToken) listOptions.pageToken = pageToken;
    const response = Tasks.Tasklists.list(listOptions);
    const items = response.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].title === title) return items[i];
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return null;
}

function listAllTasks_(listId) {
  const all = [];
  let pageToken;
  do {
    const taskOptions = {
      showCompleted: true,
      showHidden: true,
      maxResults: 100
    };
    if (pageToken) taskOptions.pageToken = pageToken;
    const response = Tasks.Tasks.list(listId, taskOptions);
    all.push.apply(all, response.items || []);
    pageToken = response.nextPageToken;
  } while (pageToken);
  return all;
}

function countOpenTasks_(listId) {
  let count = 0;
  let pageToken;
  do {
    const options = { showCompleted: false, showHidden: false, maxResults: 100 };
    if (pageToken) options.pageToken = pageToken;
    const response = Tasks.Tasks.list(listId, options);
    count += (response.items || []).filter(function (task) { return !task.deleted; }).length;
    pageToken = response.nextPageToken;
  } while (pageToken);
  return count;
}

function syncRecordTask_(record, updateExisting, allowSearch, createIfMissing) {
  const list = ensureTasksList_();
  const indexSheet = getIndexSheet_(getSpreadsheet_());
  const entry = findIndexEntry_(indexSheet, record.id);
  let task = null;
  if (entry && entry.taskId && entry.taskListId === list.id) {
    try { task = Tasks.Tasks.get(list.id, entry.taskId); } catch (err) { task = null; }
  }
  if (!task && allowSearch) task = findTaskByDocumentId_(list.id, record.id);
  if (!task && createIfMissing === false) return null;
  const hadTask = !!task;
  const wasOpen = hadTask && task.status !== "completed";
  const body = {
    title: "【" + record.category + "】" + record.subject,
    notes: "資料ID：" + record.id + "\n案件資料夾：" + record.folderUrl
  };
  if (record.dueDate) body.due = record.dueDate + "T00:00:00.000Z";
  else if (task && updateExisting) body.due = null;
  if (record.status === "已結案") {
    body.status = "completed";
    body.completed = new Date().toISOString();
  }
  if (task && updateExisting) {
    task = Tasks.Tasks.patch(body, list.id, task.id);
  } else if (!task) {
    if (record.status !== "已結案") body.status = "needsAction";
    task = Tasks.Tasks.insert(body, list.id);
  }
  const isOpen = task.status !== "completed";
  if (wasOpen !== isOpen) adjustOpenTaskCount_(list.id, isOpen ? 1 : -1);
  else if (!hadTask && isOpen) adjustOpenTaskCount_(list.id, 1);
  upsertIndex_(indexSheet, {
    id: record.id, rowIndex: record.rowIndex,
    folderId: folderIdFromUrl_(record.folderUrl),
    taskListId: list.id, taskId: task.id
  });
  return task;
}

function findTaskByDocumentId_(listId, documentId) {
  const marker = "資料ID：" + documentId;
  const tasks = listAllTasks_(listId);
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].deleted && String(tasks[i].notes || "").indexOf(marker) !== -1) return tasks[i];
  }
  return null;
}

function setLinkedTaskCompleted_(documentId, completed) {
  const indexSheet = getIndexSheet_(getSpreadsheet_());
  const entry = findIndexEntry_(indexSheet, documentId);
  if (!entry || !entry.taskId) return;
  const list = ensureTasksList_();
  const task = Tasks.Tasks.get(list.id, entry.taskId);
  const wasOpen = task.status !== "completed";
  if (wasOpen === !completed) return;
  const body = completed
    ? { status: "completed", completed: new Date().toISOString() }
    : { status: "needsAction", completed: null };
  const updated = Tasks.Tasks.patch(body, list.id, task.id);
  const isOpen = updated.status !== "completed";
  if (wasOpen !== isOpen) adjustOpenTaskCount_(list.id, isOpen ? 1 : -1);
}

function simplifyTask_(task) {
  return {
    id: task.id,
    title: task.title || "",
    notes: task.notes || "",
    status: task.status || "needsAction",
    dueDate: task.due ? String(task.due).slice(0, 10) : "",
    completed: task.status === "completed",
    webViewLink: task.webViewLink || ""
  };
}

function normalizeFiles_(files) {
  if (!files) return [];
  if (!Array.isArray(files)) throw new Error("附件資料格式不正確。");
  const normalized = files.map(function (file) {
    if (!file || typeof file.data !== "string") throw new Error("附件內容缺少 Base64 資料。");
    return {
      name: requiredText_(file.name, "附件檔名", 250),
      mimeType: optionalText_(file.mimeType, 200) || "application/octet-stream",
      data: file.data
    };
  });
  let total = 0;
  normalized.forEach(function (file) { total += base64DecodedSize_(file.data); });
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error("本次附件合計超過 " + Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024) + " MB。");
  }
  const encodedLength = normalized.reduce(function (sum, file) {
    return sum + file.data.replace(/^data:[^,]*,/, "").replace(/\s/g, "").length;
  }, 0);
  if (encodedLength > MAX_REQUEST_JSON_BYTES) {
    throw new Error("檔案合計過大，請分批上傳或只留重點附件。");
  }
  return normalized;
}

function base64DecodedSize_(data) {
  const raw = String(data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  return Math.floor(raw.length * 3 / 4) - (raw.endsWith("==") ? 2 : (raw.endsWith("=") ? 1 : 0));
}

function requiredText_(value, label, maxLength) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new Error(label + "不可空白。");
  if (text.length > maxLength) throw new Error(label + "不可超過 " + maxLength + " 個字元。");
  return text;
}

function optionalText_(value, maxLength) {
  const text = String(value == null ? "" : value);
  if (text.length > maxLength) throw new Error("文字內容不可超過 " + maxLength + " 個字元。");
  return text;
}

function normalizeStatus_(value) {
  const status = String(value || "");
  if (VALID_STATUSES.indexOf(status) === -1) throw new Error("執行狀態不正確。");
  return status;
}

function normalizeDate_(value, required) {
  const text = String(value || "").trim();
  if (!text) {
    if (required) throw new Error("發文/登記日期不可空白。");
    return "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("日期格式必須為 YYYY-MM-DD。");
  const parsed = parseDate_(text);
  if (Utilities.formatDate(parsed, TIME_ZONE, "yyyy-MM-dd") !== text) throw new Error("日期無效。");
  return text;
}

function parseDate_(text) {
  return Utilities.parseDate(String(text), TIME_ZONE, "yyyy-MM-dd");
}

function dateString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TIME_ZONE, "yyyy-MM-dd");
  }
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return "";
}

function dateTimeString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TIME_ZONE, "yyyy-MM-dd HH:mm:ss");
  }
  return String(value || "");
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, TIME_ZONE, "yyyy-MM-dd HH:mm");
}

function sanitizeName_(name) {
  return String(name || "未命名")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "未命名";
}

function safeSheetText_(value) {
  const text = String(value == null ? "" : value);
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

function unsafeSheetText_(value) {
  const text = String(value == null ? "" : value);
  return /^'\s*[=+\-@]/.test(text) ? text.slice(1) : text;
}

function folderIdFromUrl_(url) {
  const match = String(url || "").match(/\/folders\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function errorMessage_(err) {
  return err && err.message ? err.message : String(err);
}
