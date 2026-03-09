(function () {
  const codeBlocks = document.querySelectorAll("pre > code");

  codeBlocks.forEach(function (codeBlock) {
    const pre = codeBlock.parentNode;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const copyButton = document.createElement("button");
    copyButton.className = "code-copy-button";
    copyButton.type = "button";
    const copyIcon = '<i class="fa-regular fa-copy"></i>';
    const checkIcon = '<i class="fa-solid fa-check"></i>';
    copyButton.innerHTML = copyIcon;
    copyButton.setAttribute("aria-label", "Copy code to clipboard");

    wrapper.appendChild(copyButton);

    copyButton.addEventListener("click", function () {
      const code = codeBlock.textContent;

      navigator.clipboard.writeText(code).then(
        function () {
          copyButton.innerHTML = checkIcon;
          copyButton.classList.add("copied");

          setTimeout(function () {
            copyButton.innerHTML = copyIcon;
            copyButton.classList.remove("copied");
          }, 2000);
        },
        function () {
          copyButton.innerHTML = copyIcon;
        },
      );
    });
  });
})();
