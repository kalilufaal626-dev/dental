async function loadDrugs() {
  try {
    const drugs = await api("/drugs");

    $("drugsTable").innerHTML = drugs.map(d => `
      <tr>
        <td>${d.name}</td>
        <td>${d.stock}</td>
        <td>${d.min_stock}</td>
        <td>${money(d.price)}</td>
        <td>
          <button class="btn secondary small" onclick="openStockModal(${d.id}, ${d.stock})">
            Stock
          </button>
        </td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

function openDrugModal() {
  openModal("Add Drug", `
    <input id="drugName" placeholder="Drug name">
    <input id="drugCategory" placeholder="Category">
    <input id="drugUnit" placeholder="Unit e.g. tablet">
    <input id="drugStock" type="number" placeholder="Stock">
    <input id="drugMinStock" type="number" placeholder="Minimum stock">
    <input id="drugPrice" type="number" placeholder="Price">
    <input id="drugExpiry" type="date">
    <input id="drugSupplier" placeholder="Supplier">

    <button class="btn primary" onclick="saveDrug()">Save Drug</button>
  `);
}

async function saveDrug() {
  try {
    await api("/drugs", {
      method: "POST",
      body: JSON.stringify({
        name: $("drugName").value,
        category: $("drugCategory").value,
        unit: $("drugUnit").value || "tablet",
        stock: Number($("drugStock").value || 0),
        min_stock: Number($("drugMinStock").value || 10),
        price: Number($("drugPrice").value || 0),
        expiry_date: $("drugExpiry").value || null,
        supplier: $("drugSupplier").value
      })
    });

    closeModal();
    loadDrugs();
    toast("Drug added.");

  } catch (err) {
    toast(err.message);
  }
}

function openStockModal(id, stock) {
  openModal("Update Stock", `
    <input id="newStock" type="number" value="${stock}">
    <button class="btn primary" onclick="saveStock(${id})">Save Stock</button>
  `);
}

async function saveStock(id) {
  try {
    await api(`/drugs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        stock: Number($("newStock").value || 0)
      })
    });

    closeModal();
    loadDrugs();
    toast("Stock updated.");

  } catch (err) {
    toast(err.message);
  }
}

async function loadPrescriptions() {
  try {
    const prescriptions = await api("/prescriptions");

    $("prescriptionsTable").innerHTML = prescriptions.map(p => `
      <tr>
        <td>${p.patient_name || ""}</td>
        <td>
          ${p.drug_name}
          <br>
          <span class="muted">${p.dosage} · ${p.frequency} · ${p.duration}</span>
        </td>
        <td>${badge(p.status)}</td>
        <td>
          ${p.status === "pending"
            ? `<button class="btn primary small" onclick="dispensePrescription(${p.id})">Dispense</button>`
            : ""
          }
        </td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

async function dispensePrescription(id) {
  try {
    await api(`/prescriptions/${id}/dispense`, {
      method: "PATCH"
    });

    loadPrescriptions();
    toast("Prescription dispensed.");

  } catch (err) {
    toast(err.message);
  }
}
