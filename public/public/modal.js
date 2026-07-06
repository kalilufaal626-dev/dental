function openModal(title, html) {
  $("modalTitle").innerText = title;
  $("modalBody").innerHTML = html;
  $("modal").style.display = "flex";
}

function closeModal() {
  $("modal").style.display = "none";
  $("modalBody").innerHTML = "";
}
