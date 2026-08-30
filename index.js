import fs from "fs";

const DB_FILE = new URL("./tasks.json", import.meta.url);

function loadTasks() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveTasks(tasks) {
  fs.writeFileSync(DB_FILE, JSON.stringify(tasks, null, 2));
}

function addTask(text) {
  const tasks = loadTasks();
  tasks.push({ text, done: false });
  saveTasks(tasks);
  console.log(`Tarea agregada: "${text}"`);
}

function listTasks() {
  const tasks = loadTasks();
  if (tasks.length === 0) {
    console.log("No hay tareas todavía.");
    return;
  }
  tasks.forEach((task, i) => {
    const mark = task.done ? "[x]" : "[ ]";
    console.log(`${i + 1}. ${mark} ${task.text}`);
  });
}

function completeTask(index) {
  const tasks = loadTasks();
  const i = index - 1;
  if (!Number.isInteger(index) || i < 0 || i >= tasks.length) {
    console.log("Número de tarea inválido.");
    return;
  }
  tasks[i].done = true;
  saveTasks(tasks);
  console.log(`Tarea completada: "${tasks[i].text}"`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "add":
    addTask(args.join(" "));
    break;
  case "list":
    listTasks();
    break;
  case "done":
    completeTask(Number(args[0]));
    break;
  default:
    console.log("Uso: node index.js <add|list|done> [argumentos]");
}
