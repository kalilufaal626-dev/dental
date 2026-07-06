const $ = id => document.getElementById(id);

function money(v){

    return "D" +
    Number(v || 0).toLocaleString();

}

function today(){

    return new Date()
        .toISOString()
        .slice(0,10);

}

function badge(status){

    return `
        <span class="badge">
            ${status || ""}
        </span>
    `;

}

function toast(message){

    const t = $("toast");

    t.innerHTML = message;

    t.style.display = "block";

    setTimeout(()=>{

        t.style.display="none";

    },3000);

}

async function api(path, options={}){

    const headers={

        "Content-Type":"application/json",

        ...(options.headers||{})

    };

    if(token){

        headers.Authorization =
            "Bearer " + token;

    }

    const res =
        await fetch(API_URL + path,{
            ...options,
            headers
        });

    const data =
        await res.json().catch(()=>({}));

    if(!res.ok){

        throw new Error(
            data.error ||
            "Server error"
        );

    }

    return data;

}
