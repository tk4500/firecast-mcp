import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";

export interface RecordListInfo {
  field: string;
  templateForm: string;
  file?: string;
  fields: string[];
  sampleItem: Record<string, any>;
}

export interface SheetTemplate {
  dataType: string;
  moduleId: string;
  pluginName: string;
  rpkFile: string;
  rootForm?: string;
  totalDirectFields: number;
  totalLists: number;
  fieldTree: Record<string, any>;
  recordLists: Record<string, RecordListInfo>;
  defaultData: Record<string, any>;
}

export function getPluginsDirectory(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Firecast", "Plugins");
}

let pluginCache: Map<string, { rpkPath: string; dataType: string; moduleId: string; title: string }> | null = null;

export function scanInstalledPlugins(): Map<string, { rpkPath: string; dataType: string; moduleId: string; title: string }> {
  if (pluginCache) return pluginCache;

  const dir = getPluginsDirectory();
  const cache = new Map<string, { rpkPath: string; dataType: string; moduleId: string; title: string }>();

  if (!fs.existsSync(dir)) {
    pluginCache = cache;
    return cache;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".rpk"));

  for (const file of files) {
    const rpkPath = path.join(dir, file);
    try {
      const zip = new AdmZip(rpkPath);
      const entries = zip.getEntries();

      let moduleId = "";
      let title = "";

      const moduleXmlEntry = entries.find(e => e.entryName === "module.xml");
      if (moduleXmlEntry) {
        const xml = moduleXmlEntry.getData().toString("utf-8");
        const idMatch = /<id>([^<]+)<\/id>/i.exec(xml) || /id=["']([^"']+)["']/i.exec(xml);
        if (idMatch) moduleId = idMatch[1].trim();
        const nameMatch = /<name>([^<]+)<\/name>/i.exec(xml) || /name=["']([^"']+)["']/i.exec(xml);
        if (nameMatch) title = nameMatch[1].trim();
      }

      for (const entry of entries) {
        if (entry.entryName.endsWith(".lfm")) {
          const content = entry.getData().toString("utf-8");
          const dtMatch = /<form[^>]+dataType\s*=\s*["']([^"']+)["']/i.exec(content);
          if (dtMatch) {
            const dt = dtMatch[1].trim();
            const formTitleMatch = /<form[^>]+title\s*=\s*["']([^"']+)["']/i.exec(content);
            const formTitle = formTitleMatch ? formTitleMatch[1].trim() : title || dt;
            cache.set(dt.toLowerCase(), { rpkPath, dataType: dt, moduleId: moduleId || file, title: formTitle });
          }
        }
      }
    } catch {
      // Ignore corrupted or unreadable RPKs
    }
  }

  pluginCache = cache;
  return cache;
}

function setNestedValue(obj: Record<string, any>, dotPath: string, value: any) {
  const parts = dotPath.split(".");
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!curr[p] || typeof curr[p] !== "object") {
      curr[p] = {};
    }
    curr = curr[p];
  }
  curr[parts[parts.length - 1]] = value;
}

export function extractSheetTemplate(dataTypeOrName: string): SheetTemplate | null {
  const cache = scanInstalledPlugins();
  const searchKey = dataTypeOrName.trim().toLowerCase();

  let found = cache.get(searchKey);

  if (!found) {
    for (const [k, v] of cache.entries()) {
      if (k.includes(searchKey) || v.moduleId.toLowerCase().includes(searchKey) || path.basename(v.rpkPath).toLowerCase().includes(searchKey)) {
        found = v;
        break;
      }
    }
  }

  // Fallback: check if direct RPK file exists
  if (!found) {
    const dir = getPluginsDirectory();
    const candidatePath = path.join(dir, dataTypeOrName.endsWith(".rpk") ? dataTypeOrName : `${dataTypeOrName}.rpk`);
    if (fs.existsSync(candidatePath)) {
      found = { rpkPath: candidatePath, dataType: dataTypeOrName, moduleId: dataTypeOrName, title: dataTypeOrName };
    }
  }

  if (!found) return null;

  const zip = new AdmZip(found.rpkPath);
  const entries = zip.getEntries();
  const namelist = entries.map(e => e.entryName);

  let rootForm: string | undefined;
  for (const entry of entries) {
    if (entry.entryName.endsWith(".lfm")) {
      const text = entry.getData().toString("utf-8");
      if (text.includes(`dataType="${found.dataType}"`) || text.includes(`dataType='${found.dataType}'`)) {
        rootForm = entry.entryName;
        break;
      }
    }
  }

  if (!rootForm) {
    for (const entry of entries) {
      if (entry.entryName.endsWith(".lfm")) {
        const text = entry.getData().toString("utf-8");
        if (text.includes("sheetTemplate")) {
          rootForm = entry.entryName;
          break;
        }
      }
    }
  }

  const formNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.entryName.endsWith(".lfm") || entry.entryName.endsWith(".xml")) {
      const text = entry.getData().toString("utf-8");
      const formRegex = /<form[^>]+name\s*=\s*["']([^"']+)["']/g;
      let m;
      while ((m = formRegex.exec(text)) !== null) {
        formNames.set(m[1].trim(), entry.entryName);
      }
    }
  }

  const allFields = new Set<string>();
  const allLists = new Map<string, string>();

  function extractFieldsAndLists(content: string) {
    const fieldRegex = /(?::setField\(|field\s*=\s*)["']([^"']+)["']/g;
    let fm;
    while ((fm = fieldRegex.exec(content)) !== null) {
      const val = fm[1].trim();
      if (!val.startsWith("$(") && val.length > 0) {
        allFields.add(val);
      }
    }

    const rlRegex1 = /<recordList[^>]+field\s*=\s*["']([^"']+)["'][^>]*templateForm\s*=\s*["']([^"']+)["']/g;
    let rlm;
    while ((rlm = rlRegex1.exec(content)) !== null) {
      if (!rlm[1].startsWith("$(") && !rlm[2].startsWith("$(")) {
        allLists.set(rlm[1].trim(), rlm[2].trim());
      }
    }

    const rlRegex2 = /<recordList[^>]+templateForm\s*=\s*["']([^"']+)["'][^>]*field\s*=\s*["']([^"']+)["']/g;
    while ((rlm = rlRegex2.exec(content)) !== null) {
      if (!rlm[1].startsWith("$(") && !rlm[2].startsWith("$(")) {
        allLists.set(rlm[2].trim(), rlm[1].trim());
      }
    }
  }

  for (const entry of entries) {
    if (entry.entryName.endsWith(".lfm") || entry.entryName.endsWith(".lfm.lua") || (entry.entryName.endsWith(".xml") && !entry.entryName.startsWith("sdk/"))) {
      const text = entry.getData().toString("utf-8");
      extractFieldsAndLists(text);
    }
  }

  const recordLists: Record<string, RecordListInfo> = {};

  for (const [listField, templateName] of allLists.entries()) {
    let subFile = formNames.get(templateName);
    if (!subFile) {
      subFile = namelist.find(n => path.basename(n).toLowerCase() === `${templateName.toLowerCase()}.lfm`);
    }

    const subFields = new Set<string>();
    if (subFile) {
      const entry = zip.getEntry(subFile);
      if (entry) {
        const subText = entry.getData().toString("utf-8");
        const sfRegex = /(?::setField\(|field\s*=\s*)["']([^"']+)["']/g;
        let sfm;
        while ((sfm = sfRegex.exec(subText)) !== null) {
          const val = sfm[1].trim();
          if (!val.startsWith("$(") && val.length > 0) {
            subFields.add(val);
          }
        }
      }

      const luaSubName = `${subFile}.lua`;
      const luaEntry = zip.getEntry(luaSubName);
      if (luaEntry) {
        const luaText = luaEntry.getData().toString("utf-8");
        const sfRegex = /(?::setField\(|field\s*=\s*)["']([^"']+)["']/g;
        let sfm;
        while ((sfm = sfRegex.exec(luaText)) !== null) {
          const val = sfm[1].trim();
          if (!val.startsWith("$(") && val.length > 0) {
            subFields.add(val);
          }
        }
      }
    }

    // Special cases: FichaMultiaba aba text
    if (found.dataType === "Ambesek.Nefertyne.FichaMultiaba" && listField === "abas") {
      subFields.add("txt");
    }

    const sampleItem: Record<string, any> = {};
    for (const sf of Array.from(subFields).sort()) {
      sampleItem[sf] = "";
    }

    recordLists[listField] = {
      field: listField,
      templateForm: templateName,
      file: subFile,
      fields: Array.from(subFields).sort(),
      sampleItem
    };
  }

  // Remove list fields from direct fields
  for (const lf of allLists.keys()) {
    allFields.delete(lf);
  }

  const fieldTree: Record<string, any> = {};
  const defaultData: Record<string, any> = {};

  for (const f of Array.from(allFields).sort()) {
    setNestedValue(fieldTree, f, "");
    setNestedValue(defaultData, f, "");
  }

  // Attach sample recordLists to defaultData
  for (const [lf, info] of Object.entries(recordLists)) {
    if (found.dataType === "Ambesek.Nefertyne.FichaMultiaba" && lf === "abas") {
      setNestedValue(defaultData, lf, [
        { index: 1, nome_aba: "Geral", txt: "" }
      ]);
    } else {
      setNestedValue(defaultData, lf, []);
    }
  }

  return {
    dataType: found.dataType,
    moduleId: found.moduleId,
    pluginName: found.title,
    rpkFile: path.basename(found.rpkPath),
    rootForm,
    totalDirectFields: allFields.size,
    totalLists: Object.keys(recordLists).length,
    fieldTree,
    recordLists,
    defaultData
  };
}
