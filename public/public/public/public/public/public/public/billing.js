async function loadInvoices() {
  try {
    const invoices = await api("/invoices");

    $("invoicesTable").innerHTML = invoices.map(i => `
      <tr>
        <td>${i.invoice_no || ""}</td>
        <td>${i.patient_name || ""}</td>
        <td>${money(i.total)}</td>
        <td>${money(i.amount_paid)}</td>
        <td>${badge(i.status)}</td>
        <td>
          <button class="btn secondary small" onclick="openPaymentModal(${i.id})">
            Pay
          </button>
        </td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

async function loadServices() {
  try {
    servicesCache = await api("/services");

    $("servicesTable").innerHTML = servicesCache.map(s => `
      <tr>
        <td>${s.name}</td>
        <td>${s.category || ""}</td>
        <td>${money(s.price)}</td>
        <td>${s.duration_mins || 0} mins</td>
      </tr>
    `).join("");

  } catch (err) {
    toast(err.message);
  }
}

async function openInvoiceModal() {
  try {
    await loadPatients();
    await loadServices();

    openModal("Create Invoice", `
      <select id="invoicePatient">
        <option value="">Select patient</option>
        ${patientsCache.map(p => `
          <option value="${p.id}">${p.full_name}</option>
        `).join("")}
      </select>

      <select id="invoiceService">
        <option value="">Select service</option>
        ${servicesCache.map(s => `
          <option value="${s.name}" data-price="${s.price || 0}">
            ${s.name} - ${money(s.price)}
          </option>
        `).join("")}
      </select>

      <input id="invoiceDiscount" type="number" value="0" placeholder="Discount">

      <textarea id="invoiceNotes" placeholder="Notes"></textarea>

      <button class="btn primary" onclick="saveInvoice()">
        Create Invoice
      </button>
    `);

  } catch (err) {
    toast(err.message);
  }
}

async function saveInvoice() {
  try {
    const serviceSelect = $("invoiceService");
    const selected = serviceSelect.selectedOptions[0];

    const serviceName = selected.value;
    const price = Number(selected.dataset.price || 0);
    const discount = Number($("invoiceDiscount").value || 0);

    await api("/invoices", {
      method: "POST",
      body: JSON.stringify({
        patient_id: $("invoicePatient").value,
        discount,
        notes: $("invoiceNotes").value,
        items: [
          {
            service: serviceName,
            quantity: 1,
            unit_price: price,
            total: price
          }
        ]
      })
    });

    closeModal();
    loadInvoices();
    toast("Invoice created.");

  } catch (err) {
    toast(err.message);
  }
}

function openPaymentModal(invoiceId) {
  openModal("Record Payment", `
    <input id="paymentAmount" type="number" placeholder="Amount paid">
    <input id="paymentMethod" placeholder="Payment method e.g. cash, card, mobile">

    <button class="btn primary" onclick="savePayment(${invoiceId})">
      Save Payment
    </button>
  `);
}

async function savePayment(invoiceId) {
  try {
    await api(`/invoices/${invoiceId}/payment`, {
      method: "PATCH",
      body: JSON.stringify({
        amount_paid: Number($("paymentAmount").value || 0),
        payment_method: $("paymentMethod").value
      })
    });

    closeModal();
    loadInvoices();
    toast("Payment recorded.");

  } catch (err) {
    toast(err.message);
  }
}

function openServiceModal() {
  openModal("Add Service", `
    <input id="serviceName" placeholder="Service name">
    <input id="serviceCategory" placeholder="Category">
    <input id="servicePrice" type="number" placeholder="Price">
    <input id="serviceDuration" type="number" value="30" placeholder="Duration in minutes">
    <textarea id="serviceDescription" placeholder="Description"></textarea>

    <button class="btn primary" onclick="saveService()">
      Save Service
    </button>
  `);
}

async function saveService() {
  try {
    await api("/services", {
      method: "POST",
      body: JSON.stringify({
        name: $("serviceName").value,
        category: $("serviceCategory").value,
        price: Number($("servicePrice").value || 0),
        duration_mins: Number($("serviceDuration").value || 30),
        description: $("serviceDescription").value
      })
    });

    closeModal();
    loadServices();
    toast("Service added.");

  } catch (err) {
    toast(err.message);
  }
}
