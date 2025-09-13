(async function () {
  // Busca a lista de instâncias já configuradas
  const res = await fetch('/api/hub/instances');
  const data = await res.json().catch(() => ({ instances: [] }));
  const instances = (data && data.instances) || [];

  const tabs = document.getElementById('tabs');
  const frame = document.getElementById('waFrame');

  function openInst(id) {
    // Reaproveita a UI clássica:
    frame.src = `/admin/whatsapp?inst=${encodeURIComponent(id)}`;
  }

  function makeTab(label, id, isActive) {
    const b = document.createElement('button');
    b.className = 'tab' + (isActive ? ' active' : '');
    b.textContent = label;
    b.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      openInst(id);
    };
    return b;
  }

  // Cria uma aba por instância
  instances.forEach((inst, i) => {
    const label = inst.label || String(inst.id);
    const tab = makeTab(label, inst.id, i === 0);
    tabs.appendChild(tab);
  });

  // Botão "+" para abrir outra instância digitando o ID
  const add = document.createElement('button');
  add.className = 'tab add';
  add.title = 'Abrir outro número por ID';
  add.textContent = '+';
  add.onclick = () => {
    const id = prompt('Digite o ID/número da instância (ex.: 4891111707):');
    if (id) {
      // Seleciona visualmente esse “+” e muda o iframe
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      add.classList.add('active');
      openInst(id.trim());
    }
  };
  tabs.appendChild(add);

  // Abre a primeira automaticamente
  if (instances[0]) openInst(instances[0].id);
})();
