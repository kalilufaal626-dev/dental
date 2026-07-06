const API_URL = "https://dentcare-api.onrender.com";

let token =
    localStorage.getItem("dentcare_token");

let user =
    JSON.parse(
        localStorage.getItem("dentcare_user")
        || "null"
    );

let currentPatient = null;

let patientsCache = [];

let doctorsCache = [];

let servicesCache = [];
