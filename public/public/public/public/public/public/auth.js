async function login(){

    try{

        const result =
            await api(
                "/auth/login",
                {
                    method:"POST",

                    body:JSON.stringify({

                        email:
                            $("loginEmail").value,

                        password:
                            $("loginPassword").value

                    })
                });

        token=result.token;

        user=result.user;

        localStorage.setItem(
            "dentcare_token",
            token
        );

        localStorage.setItem(
            "dentcare_user",
            JSON.stringify(user)
        );

        initApplication();

    }

    catch(err){

        toast(err.message);

    }

}

async function setupAdmin(){

    try{

        await api(
            "/auth/setup",
            {

                method:"POST",

                body:JSON.stringify({

                    full_name:
                        $("setupName").value,

                    email:
                        $("setupEmail").value,

                    password:
                        $("setupPassword").value,

                    secret:
                        $("setupSecret").value

                })

            });

        toast(
            "Admin account created."
        );

    }

    catch(err){

        toast(err.message);

    }

}

function logout(){

    localStorage.clear();

    location.reload();

}
